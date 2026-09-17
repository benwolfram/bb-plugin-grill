import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginAgentToolContentPart,
  type PluginInteractionResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const RENDERER_ID = "grill-round";
const ROUND_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 8;
const MAX_CUSTOM_CHARS = 500;
const MAX_PAYLOAD_BYTES = 48 * 1024;
const WAIT_CHUNK_TIMEOUT_MS = 120_000; // 2 minutes (safe against 5m Undici and 3m ACP limits)

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
      "Your recommended choice in your own words, e.g. \"Postgres with pgvector — gives us relational integrity and vector search in one operational footprint.\" May combine or qualify the options.",
    ),
  options: z
    .array(optionSchema)
    .max(MAX_OPTIONS)
    .optional()
    .describe(
      "Discrete alternatives. Always include the recommended option here too so the user can just click it.",
    ),
  multiple: z
    .boolean()
    .optional()
    .describe(
      "Set true when the choices are not mutually exclusive and the user may pick more than one.",
    ),
});

const roundSchema = z.object({
  intro: z
    .string()
    .max(1000)
    .optional()
    .describe("Optional one-or-two sentence framing shown above the round."),
  questions: z
    .array(questionSchema)
    .min(1)
    .max(MAX_QUESTIONS)
    .optional()
    .describe(
      "The entire frontier of decisions for this round. Ask all questions whose prerequisites are met now. Omit when calling to wait on an active round.",
    ),
  wait: z
    .boolean()
    .optional()
    .describe("Set true to continue waiting on the active grilling round in this thread."),
});

const waitSchema = z.object({
  roundId: z
    .string()
    .optional()
    .describe("Optional ID of the active grilling round to wait on."),
});

type Round = z.infer<typeof roundSchema>;

const responseSchema = z.object({
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

interface Choice {
  id: string;
  label: string;
  detail?: string;
  recommended: boolean;
}

interface PayloadQuestion {
  id: string;
  title: string;
  body?: string;
  recommendation: string;
  multiple: boolean;
  choices: Choice[];
}

interface Payload {
  intro?: string;
  questions: PayloadQuestion[];
}

function normalizeOptionText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function toPayload(round: { intro?: string; questions: z.infer<typeof questionSchema>[] }): Payload {
  return {
    ...(round.intro ? { intro: round.intro } : {}),
    questions: round.questions.map((question, qIndex) => {
      const qId = `q${qIndex + 1}`;
      const opts = question.options ?? [];
      const recNorm = normalizeOptionText(question.recommendation);

      const matchingOptionIndex = opts.findIndex((opt) => {
        const labelNorm = normalizeOptionText(opt.label);
        return (
          labelNorm === recNorm ||
          recNorm.startsWith(labelNorm) ||
          labelNorm.startsWith(recNorm)
        );
      });

      const choices: Choice[] = opts.map((opt, oIndex) => {
        const isRec =
          matchingOptionIndex !== -1
            ? oIndex === matchingOptionIndex
            : false;
        return {
          id: `${qId}_c${oIndex + 1}`,
          label: opt.label,
          detail: opt.detail,
          recommended: isRec,
        };
      });

      if (matchingOptionIndex === -1) {
        choices.unshift({
          id: `${qId}_c0`,
          label: question.recommendation,
          recommended: true,
        });
      }

      return {
        id: qId,
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

interface ActiveRound {
  id: string;
  threadId: string;
  questions: PayloadQuestion[];
  promise: Promise<{
    content: PluginAgentToolContentPart[];
    isError?: boolean;
  }>;
  abortController: AbortController;
  createdAt: number;
  resolvedResult?: {
    content: PluginAgentToolContentPart[];
    isError?: boolean;
  };
}

const activeRoundsByThread = new Map<string, ActiveRound>();

async function processRoundResult(
  bb: BbPluginApi,
  payload: FitPayload,
  result: PluginInteractionResult,
): Promise<{ content: PluginAgentToolContentPart[]; isError?: boolean }> {
  if (result.outcome === "cancelled") {
    return {
      content: [
        {
          type: "text" as const,
          text: `The user dismissed the round (${result.reason}). Ask this round in plain chat instead, and do not call grill_round again for it.`,
        },
      ],
      isError: true,
    };
  }

  const parsed = responseSchema.safeParse(result.value);
  const known =
    parsed.success &&
    parsed.data.answers.every((answer) => {
      const question = payload.questions.find((q) => q.id === answer.id);
      if (!question) return false;
      if (!question.multiple && answer.choiceIds.length > 1) return false;
      return answer.choiceIds.every((choiceId) =>
        question.choices.some((choice) => choice.id === choiceId),
      );
    });

  if (!parsed.success || !known) {
    bb.log.warn(
      `malformed round response: ${
        parsed.success
          ? "answers do not match the round"
          : parsed.error.message
      }`,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: "The answers came back malformed. Ask this round in plain chat instead.",
        },
      ],
      isError: true,
    };
  }

  const contentParts: PluginAgentToolContentPart[] = [
    {
      type: "text",
      text: formatAnswers(payload.questions, parsed.data.answers),
    },
  ];

  for (const answer of parsed.data.answers) {
    if (answer.images) {
      for (const img of answer.images) {
        try {
          const bytes = await fs.readFile(img.path);
          contentParts.push({
            type: "image",
            data: bytes.toString("base64"),
            mimeType: img.mimeType,
          });
        } catch (err) {
          bb.log.warn(
            `Could not read attached image ${img.path}: ${String(err)}`,
          );
        }
      }
    }
  }

  return {
    content: contentParts,
  };
}

function startRound(
  bb: BbPluginApi,
  threadId: string,
  payload: FitPayload,
): ActiveRound {
  // If an existing round is running for this thread, abort it
  const existing = activeRoundsByThread.get(threadId);
  if (existing) {
    existing.abortController.abort();
    activeRoundsByThread.delete(threadId);
  }

  const roundId = Math.random().toString(36).slice(2, 10);
  const abortController = new AbortController();
  const count = payload.questions.length;
  const title = `Grilling — ${count} question${count === 1 ? "" : "s"}`;

  const roundPromise = (async (): Promise<{
    content: PluginAgentToolContentPart[];
    isError?: boolean;
  }> => {
    while (!abortController.signal.aborted) {
      try {
        // We pass abortController.signal, completely decoupled from the incoming HTTP request signal.
        // This ensures Undici/proxy body timeouts never abort the pending interaction on screen.
        const result = await bb.ui.requestInput(
          {
            threadId,
            rendererId: RENDERER_ID,
            title,
            payload: payload as never,
            timeoutMs: ROUND_TIMEOUT_MS,
          },
          { signal: abortController.signal },
        );

        if (result.outcome === "cancelled" && result.reason === "timeout") {
          bb.log.info(
            `Grill round timed out after 1 hour on thread ${threadId}; renewing interaction`,
          );
          continue;
        }

        return await processRoundResult(bb, payload, result);
      } catch (err) {
        bb.log.warn(`Grill round interaction error: ${String(err)}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `The grill form encountered an error: ${String(err)}. Ask this round in plain chat instead.`,
            },
          ],
          isError: true,
        };
      }
    }
    return {
      content: [
        {
          type: "text" as const,
          text: "The grilling round was cancelled.",
        },
      ],
      isError: true,
    };
  })();

  const activeRound: ActiveRound = {
    id: roundId,
    threadId,
    questions: payload.questions,
    promise: roundPromise,
    abortController,
    createdAt: Date.now(),
  };

  roundPromise.then((processed) => {
    activeRound.resolvedResult = processed;
  });

  activeRoundsByThread.set(threadId, activeRound);
  return activeRound;
}

async function waitForRound(
  activeRound: ActiveRound,
  signal: AbortSignal,
): Promise<{ content: PluginAgentToolContentPart[]; isError?: boolean }> {
  if (activeRound.resolvedResult) {
    activeRoundsByThread.delete(activeRound.threadId);
    return activeRound.resolvedResult;
  }

  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), WAIT_CHUNK_TIMEOUT_MS);
    signal.addEventListener(
      "abort",
      () => {
        if (timer) clearTimeout(timer);
        resolve("timeout");
      },
      { once: true },
    );
  });

  const outcome = await Promise.race([
    activeRound.promise.then(() => "done" as const),
    timeoutPromise,
  ]);

  if (timer) clearTimeout(timer);

  if (signal.aborted) {
    return {
      content: [
        {
          type: "text" as const,
          text: "The grilling wait was interrupted.",
        },
      ],
      isError: true,
    };
  }

  if (outcome === "done") {
    activeRoundsByThread.delete(activeRound.threadId);
    return (
      activeRound.resolvedResult ?? {
        content: [
          {
            type: "text" as const,
            text: "The grilling round finished.",
          },
        ],
      }
    );
  }

  // Timeout chunk reached: the user is still answering on screen
  const elapsedMinutes = Math.max(
    1,
    Math.round((Date.now() - activeRound.createdAt) / 60_000),
  );

  return {
    content: [
      {
        type: "text" as const,
        text: `The grilling round is on screen, and the user is still reviewing and answering (elapsed: ~${elapsedMinutes}m). You MUST call grill_wait (or grill_round with wait: true) immediately to continue waiting. Do NOT ask the questions in chat or proceed without answers.`,
      },
    ],
  };
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

  bb.agents.registerTool({
    name: "grill_round",
    description:
      "Put a whole round of grilling questions to the user as a form and begin waiting for their answers. Each question carries its prose, your recommended answer, and discrete options.",
    instructions:
      "When you are grilling the user — a round of numbered questions each with a recommended answer — submit the whole round through grill_round instead of printing the questions into the chat. Write the questions exactly as you otherwise would: the question body is the prose you would have written, and the recommendation is your recommended answer in your own words, which may combine options. Ask the entire frontier in one call. If grill_round returns that answers are still pending, call grill_wait immediately to continue waiting. If the round was dismissed by the user, fall back to asking in plain chat.",
    presentation: {
      label: {
        pending: "Grilling — waiting for answers",
        completed: "Grilling round started",
      },
    },
    parameters: roundSchema,
    async execute(input, { threadId, signal }) {
      const activeExisting = activeRoundsByThread.get(threadId);

      if (input.wait || !input.questions) {
        if (!activeExisting) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No active grilling round found in this thread. Call grill_round with questions to start one.",
              },
            ],
            isError: true,
          };
        }
        return await waitForRound(activeExisting, signal);
      }

      const round = input as { intro?: string; questions: z.infer<typeof questionSchema>[] };
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

      const activeRound = startRound(bb, threadId, payload);
      return await waitForRound(activeRound, signal);
    },
  });

  bb.agents.registerTool({
    name: "grill_wait",
    description:
      "Wait for the user to submit their answers to an active grilling round.",
    instructions:
      "Wait for the user to submit their answers to an active grilling round. If grill_wait returns that the user is still answering, call grill_wait again immediately to keep waiting. Keep waiting until answers are returned or the round is dismissed. Do not proceed or hallucinate answers without the user's response.",
    presentation: {
      label: {
        pending: "Grilling — waiting for answers",
        completed: "Grilling round answered",
      },
    },
    parameters: waitSchema,
    async execute(_input, { threadId, signal }) {
      const activeRound = activeRoundsByThread.get(threadId);
      if (!activeRound) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No active grilling round found in this thread. Call grill_round to present questions to the user.",
            },
          ],
          isError: true,
        };
      }

      return await waitForRound(activeRound, signal);
    },
  });

  bb.onDispose(() => {
    for (const round of activeRoundsByThread.values()) {
      round.abortController.abort();
    }
    activeRoundsByThread.clear();
  });

  bb.log.info("grill ready");
}
