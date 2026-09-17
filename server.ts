import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginInteractionResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

type ThreadSendInput = Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0]["input"];
type SinglePromptInput = ThreadSendInput[number];

const RENDERER_ID = "grill-round";
const ROUND_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour lease per interaction
const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 8;
const MAX_CUSTOM_CHARS = 500;
const MAX_PAYLOAD_BYTES = 48 * 1024;

export interface ImageAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  [key: string]: string;
}

const optionSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(200)
    .describe("The choice the user clicks, e.g. \"Postgres\"."),
  detail: z
    .string()
    .max(600)
    .optional()
    .describe(
      "Why the user might pick this over the recommendation, or how it differs.",
    ),
});

const questionSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(160)
    .describe("Short question title, e.g. \"Storage engine\"."),
  body: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "The question itself, as markdown. Same prose you would have printed, including how the options differ.",
    ),
  recommendation: z
    .string()
    .min(1)
    .max(600)
    .describe(
      "Your recommended answer in your own words. It may combine options (e.g. \"Postgres, but Redis for caching\"). It will be matched to the options to pick default selections, and shown to the user as your advice.",
    ),
  options: z
    .array(optionSchema)
    .min(1)
    .max(MAX_OPTIONS)
    .describe(
      "Discrete choices. Do NOT include a \"custom\" or \"other\" option — the form provides a free-text field automatically.",
    ),
  multiple: z
    .boolean()
    .optional()
    .describe(
      "True if the user may select more than one option. Defaults to false.",
    ),
});

export const roundSchema = z.object({
  intro: z
    .string()
    .max(1000)
    .optional()
    .describe(
      "Brief framing for the whole round, shown above the questions.",
    ),
  questions: z
    .array(questionSchema)
    .min(1)
    .max(MAX_QUESTIONS)
    .describe("The questions in this round."),
});

export type Round = z.infer<typeof roundSchema>;

export interface Choice {
  id: string;
  label: string;
  detail?: string;
  recommended: boolean;
}

export interface PayloadQuestion {
  id: string;
  title: string;
  body?: string;
  recommendation: string;
  multiple: boolean;
  choices: Choice[];
}

export interface Payload {
  intro?: string;
  questions: PayloadQuestion[];
}

export const responseSchema = z.object({
  answers: z.array(
    z.object({
      id: z.string(),
      choiceIds: z.array(z.string()),
      custom: z.string().max(MAX_CUSTOM_CHARS).optional(),
      images: z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            path: z.string(),
            mimeType: z.string(),
          }),
        )
        .optional(),
    }),
  ),
});

function scoreRecommendationMatch(label: string, recommendation: string): number {
  const normLabel = label.trim().toLowerCase();
  const normRec = recommendation.trim().toLowerCase();
  if (normLabel === normRec) return 100;
  const wordRegex = new RegExp(`\\b${normLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (wordRegex.test(normRec)) return 50;
  if (normRec.includes(normLabel)) return 20;
  return 0;
}

function deduplicateOptions(
  options: z.infer<typeof optionSchema>[],
  recommendation: string,
): z.infer<typeof optionSchema>[] {
  const seen = new Map<string, { opt: z.infer<typeof optionSchema>; score: number }>();
  for (const opt of options) {
    const key = opt.label.trim().toLowerCase();
    const score = scoreRecommendationMatch(opt.label, recommendation);
    const existing = seen.get(key);
    if (!existing || score > existing.score || (!existing.opt.detail && opt.detail)) {
      seen.set(key, { opt, score });
    }
  }
  return Array.from(seen.values()).map((v) => v.opt);
}

function toPayload(round: Round): Payload {
  return {
    intro: round.intro,
    questions: round.questions.map((question, qIndex) => {
      const deduped = deduplicateOptions(question.options, question.recommendation);
      const scored = deduped.map((opt, oIndex) => ({
        id: `c_${oIndex + 1}`,
        label: opt.label,
        detail: opt.detail,
        score: scoreRecommendationMatch(opt.label, question.recommendation),
      }));

      const maxScore = Math.max(0, ...scored.map((s) => s.score));
      const hasMatch = maxScore > 0;

      const choices: Choice[] = scored.map((s, idx) => ({
        id: s.id,
        label: s.label,
        detail: s.detail,
        recommended: hasMatch ? s.score === maxScore : idx === 0,
      }));

      return {
        id: `q_${qIndex + 1}`,
        title: question.title,
        body: question.body,
        recommendation: question.recommendation,
        multiple: question.multiple ?? false,
        choices,
      };
    }),
  };
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

type FitPayload = Payload;

function fitPayload(payload: Payload): FitPayload | null {
  if (bytes(payload) <= MAX_PAYLOAD_BYTES) return payload;

  let trimmed: Payload = {
    ...payload,
    questions: payload.questions.map((question) => ({
      ...question,
      choices: question.choices.map((choice) => {
        const { detail: _, ...rest } = choice;
        return rest;
      }),
    })),
  };
  if (bytes(trimmed) <= MAX_PAYLOAD_BYTES) return trimmed;

  for (const limit of [800, 300, 0]) {
    trimmed = {
      ...trimmed,
      questions: trimmed.questions.map((question) => {
        if (!question.body) return question;
        const { body, ...rest } = question;
        if (limit === 0) return rest;
        return body.length <= limit
          ? question
          : { ...rest, body: `${body.slice(0, limit)}…` };
      }),
    };
    if (bytes(trimmed) <= MAX_PAYLOAD_BYTES) return trimmed;
  }
  return null;
}

/** Render the answers as the text the agent reads back. */
function formatAnswers(
  questions: PayloadQuestion[],
  answers: z.infer<typeof responseSchema>["answers"],
): string {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const blocks = questions.map((question, index) => {
    const answer = byId.get(question.id);
    const lines = [`Q${index + 1} — ${question.title}`];
    const picked = (answer?.choiceIds ?? [])
      .map((choiceId) => question.choices.find((c) => c.id === choiceId))
      .filter((choice): choice is Choice => Boolean(choice));
    for (const choice of picked) {
      lines.push(
        choice.recommended
          ? `  chose: ${choice.label} (your recommendation)`
          : `  chose: ${choice.label}`,
      );
    }
    if (answer?.custom?.trim()) {
      lines.push(`  in their own words: ${answer.custom.trim()}`);
    }
    if (answer?.images && answer.images.length > 0) {
      for (const img of answer.images) {
        lines.push(`  attached image: [${img.name}](file://${img.path})`);
      }
    }
    if (
      picked.length === 0 &&
      !answer?.custom?.trim() &&
      (!answer?.images || answer.images.length === 0)
    ) {
      lines.push("  no answer given — treat this question as still open");
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

function getGrillImageDir(threadId: string): string {
  return path.join(os.homedir(), ".bb", "grill-images", threadId);
}

export const grillRpcContract = defineRpcContract({
  saveImage: {
    input: z.object({
      threadId: z.string(),
      dataBase64: z.string(),
      mimeType: z.string(),
      name: z.string().optional(),
    }),
    output: z.object({
      id: z.string(),
      path: z.string(),
      name: z.string(),
      mimeType: z.string(),
    }),
  },
  getImage: {
    input: z.object({
      threadId: z.string(),
      imageId: z.string(),
    }),
    output: z.object({
      dataBase64: z.string(),
      mimeType: z.string(),
    }),
  },
  deleteImage: {
    input: z.object({
      threadId: z.string(),
      imageId: z.string(),
    }),
    output: z.object({
      ok: z.boolean(),
    }),
  },
});

interface ActiveRoundState {
  questions: PayloadQuestion[];
  abortController: AbortController;
}

const activeRounds = new Map<string, ActiveRoundState>();

/**
 * Reliably deliver answers to the thread without dropping messages when child
 * threads, background tasks, or active turns are in progress.
 */
async function reliablySendMessage(
  bb: BbPluginApi,
  threadId: string,
  input: ThreadSendInput,
): Promise<void> {
  const maxWaitSeconds = 60;
  for (let attempt = 0; attempt < maxWaitSeconds; attempt++) {
    try {
      const thread = await bb.sdk.threads.get({ threadId });

      if (thread.status === "active") {
        // Thread is active (e.g. subagent or ongoing turn); wait 1 second for it to settle
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      await bb.sdk.threads.send({
        threadId,
        input,
        mode: "start",
      });
      bb.log.info(`Delivered grill answers to thread ${threadId}`);
      return;
    } catch (err) {
      bb.log.warn(
        `Attempt ${attempt + 1} to send grill answers failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Fallback if thread remained active or send failed: queue message
  try {
    bb.log.info(`Queueing grill answers for thread ${threadId} via queuedMessages`);
    await bb.sdk.threads.queuedMessages.create({
      threadId,
      input,
    });
  } catch (queueErr) {
    bb.log.error(
      `Failed to queue grill answers: ${queueErr instanceof Error ? queueErr.message : String(queueErr)}`,
    );
  }
}

export default async function plugin(bb: BbPluginApi) {
  // Register RPC for saving, fetching, and deleting pasted images
  bb.rpc.register(grillRpcContract, {
    async saveImage({ threadId, dataBase64, mimeType, name }) {
      const dir = getGrillImageDir(threadId);
      await fs.mkdir(dir, { recursive: true });

      const ext =
        mimeType === "image/png"
          ? ".png"
          : mimeType === "image/jpeg" || mimeType === "image/jpg"
            ? ".jpg"
            : mimeType === "image/gif"
              ? ".gif"
              : mimeType === "image/webp"
                ? ".webp"
                : ".png";

      const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const fileName = `${id}${ext}`;
      const filePath = path.join(dir, fileName);
      const buffer = Buffer.from(dataBase64, "base64");
      await fs.writeFile(filePath, buffer);

      const displayName = name || `screenshot-${Date.now()}${ext}`;

      return {
        id,
        path: filePath,
        name: displayName,
        mimeType,
      };
    },

    async getImage({ threadId, imageId }) {
      const dir = getGrillImageDir(threadId);
      const files = await fs.readdir(dir).catch(() => []);
      const match = files.find((f) => f.startsWith(imageId));
      if (!match) {
        throw new Error(`Image not found: ${imageId}`);
      }
      const filePath = path.join(dir, match);
      const buffer = await fs.readFile(filePath);
      const ext = path.extname(match).toLowerCase();
      const mimeType =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".gif"
            ? "image/gif"
            : ext === ".webp"
              ? "image/webp"
              : "image/png";

      return {
        dataBase64: buffer.toString("base64"),
        mimeType,
      };
    },

    async deleteImage({ threadId, imageId }) {
      const dir = getGrillImageDir(threadId);
      const files = await fs.readdir(dir).catch(() => []);
      const match = files.find((f) => f.startsWith(imageId));
      if (match) {
        await fs.unlink(path.join(dir, match)).catch(() => {});
      }
      return { ok: true };
    },
  });

  async function collect(
    threadId: string,
    questions: PayloadQuestion[],
    title: string,
    payload: FitPayload,
  ) {
    const abortController = new AbortController();
    activeRounds.set(threadId, { questions, abortController });

    try {
      while (!abortController.signal.aborted) {
        let result: PluginInteractionResult;
        try {
          result = await bb.ui.requestInput(
            {
              threadId,
              rendererId: RENDERER_ID,
              title,
              payload: payload as never,
              timeoutMs: ROUND_TIMEOUT_MS,
            },
            { signal: abortController.signal },
          );
        } catch (cause) {
          bb.log.warn(
            `round requestInput failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
          break;
        }

        if (result.outcome === "cancelled") {
          if (result.reason === "timeout") {
            if (activeRounds.has(threadId)) {
              bb.log.info(
                `round 1-hour lease expired for thread ${threadId}; renewing interaction`,
              );
              continue;
            }
          }
          bb.log.info(`round dismissed (${result.reason})`);
          break;
        }

        const parsed = responseSchema.safeParse(result.value);
        if (!parsed.success) {
          bb.log.warn(`malformed round response: ${parsed.error.message}`);
          await reliablySendMessage(bb, threadId, [
            {
              type: "text",
              text: "The grilling form returned answers that could not be parsed. Please ask your questions again in plain chat.",
              mentions: [],
            },
          ]);
          break;
        }

        const text = `Answers to the grilling round:\n\n${formatAnswers(questions, parsed.data.answers)}`;
        const localImages: SinglePromptInput[] = [];

        for (const answer of parsed.data.answers) {
          if (answer.images && answer.images.length > 0) {
            for (const img of answer.images) {
              localImages.push({
                type: "localImage",
                path: img.path,
              } as SinglePromptInput);
            }
          }
        }

        const input: ThreadSendInput = [
          { type: "text", text, mentions: [] },
          ...localImages,
        ];

        await reliablySendMessage(bb, threadId, input);
        break;
      }
    } finally {
      activeRounds.delete(threadId);
    }
  }

  bb.agents.registerTool({
    name: "grill_round",
    description:
      "Put a whole round of grilling questions to the user as a form. Returns immediately; the user's answers will arrive automatically as a new message when submitted.",
    instructions:
      "When you are grilling the user — a round of numbered questions each with a recommended answer — submit the whole round through grill_round instead of printing the questions into the chat. Write the questions exactly as you otherwise would: the question body is the prose you would have written, and the recommendation is your recommended answer in your own words, which may combine options. Ask the entire frontier in one call. The tool puts the interactive form on screen and returns immediately: say one short line acknowledging the form is on screen, and END YOUR TURN. Do NOT wait, do NOT poll, and do NOT call any tools. The user's answers will arrive as a fresh message once they submit.",
    presentation: {
      label: {
        pending: "Displaying grilling round",
        completed: "Grilling round on screen",
      },
    },
    parameters: roundSchema,
    async execute(input, { threadId }) {
      const existing = activeRounds.get(threadId);
      if (existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: "A grilling round is already on screen in this thread. Please wait for the user to submit.",
            },
          ],
          isError: true,
        };
      }

      const round = input as Round;
      const payload = fitPayload(toPayload(round));
      if (payload === null) {
        return {
          content: [
            {
              type: "text" as const,
              text: "This round is too large to render as a form. Split it into fewer questions, or shorten the question bodies, and call grill_round again.",
            },
          ],
          isError: true,
        };
      }

      const count = payload.questions.length;
      const title = `Grilling — ${count} question${count === 1 ? "" : "s"}`;

      void collect(threadId, payload.questions, title, payload);

      return `The grilling round is on screen for the user (${count} questions). Say one brief line acknowledging that you're waiting for their answers, and END YOUR TURN now. Do not call any tools. Their answers will arrive automatically as a new message when submitted.`;
    },
  });

  bb.onDispose(() => {
    for (const round of activeRounds.values()) {
      round.abortController.abort();
    }
    activeRounds.clear();
  });

  bb.log.info("grill ready");
}
