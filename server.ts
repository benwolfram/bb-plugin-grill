// bb-plugin-grill — backend entry.
//
// One agent tool, `grill_round`, hands a whole round of grilling questions to
// the app and blocks until the user answers. The agent still owns the design
// tree, the question wording and the recommendation; this plugin only carries
// the round to a form and the answers back.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Renderer id — also the `pendingInteraction` slot id in app.tsx. */
const RENDERER_ID = "grill-round";

/** bb caps an interaction payload at 64 KiB; stay well under it. */
const MAX_BODY_CHARS = 2000;
const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 8;
/** Longest answer the user may type per question; the panel caps it too. */
const MAX_CUSTOM_CHARS = 4000;
/** bb rejects a payload over 64 KiB; leave headroom for the envelope. */
const MAX_PAYLOAD_BYTES = 56 * 1024;

const optionSchema = z.object({
  label: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(600).optional(),
});

const questionSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .describe("Short question title, e.g. 'Storage engine'."),
  body: z
    .string()
    .trim()
    .max(MAX_BODY_CHARS)
    .optional()
    .describe(
      "The question itself, as markdown. Same prose you would have printed, including how the options differ.",
    ),
  recommendation: z
    .string()
    .trim()
    .min(1)
    .max(600)
    .describe(
      "Your recommended answer, in your own words. Shown as the first, pre-selected choice, so it may blend options or name something no option states.",
    ),
  options: z
    .array(optionSchema)
    .max(MAX_OPTIONS)
    .optional()
    .describe(
      "The discrete alternatives, listed after the recommendation. Omit when the question has no clean multiple choice.",
    ),
  multiple: z
    .boolean()
    .optional()
    .describe(
      "Set only when the choices genuinely combine; otherwise the user picks exactly one.",
    ),
});

const roundSchema = z.object({
  intro: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .describe("Optional one-or-two sentence framing shown above the round."),
  questions: z.array(questionSchema).min(1).max(MAX_QUESTIONS),
});

/** What the panel sends back. Validated before the agent ever sees it. */
const responseSchema = z.object({
  answers: z
    .array(
      z.object({
        id: z.string(),
        choiceIds: z.array(z.string()).max(MAX_OPTIONS + 1),
        custom: z.string().max(MAX_CUSTOM_CHARS).optional(),
      }),
    )
    .max(MAX_QUESTIONS),
});

type Round = z.infer<typeof roundSchema>;

type Choice = {
  id: string;
  label: string;
  detail?: string;
  recommended: boolean;
};

type PayloadQuestion = {
  id: string;
  title: string;
  body?: string;
  multiple: boolean;
  choices: Choice[];
};

/**
 * Flatten a round into what the panel draws: one list of choices per question
 * whose first entry is the recommendation.
 */
function toPayload(round: Round): {
  intro?: string;
  questions: PayloadQuestion[];
} {
  return {
    ...(round.intro ? { intro: round.intro } : {}),
    questions: round.questions.map((question, index) => {
      const qid = `q${index + 1}`;
      const choices: Choice[] = [
        {
          id: `${qid}-rec`,
          label: question.recommendation,
          recommended: true,
        },
        ...(question.options ?? []).map((option, optionIndex) => ({
          id: `${qid}-o${optionIndex + 1}`,
          label: option.label,
          ...(option.detail ? { detail: option.detail } : {}),
          recommended: false,
        })),
      ];
      return {
        id: qid,
        title: question.title,
        ...(question.body ? { body: question.body } : {}),
        multiple: question.multiple === true,
        choices,
      };
    }),
  };
}

/**
 * bb rejects an oversized payload outright, so shrink a fat round before it
 * reaches the wire: drop option details first, then clip question bodies.
 * Returns null when even the trimmed round will not fit.
 */
function fitPayload(
  payload: { intro?: string; questions: PayloadQuestion[] },
): { intro?: string; questions: PayloadQuestion[] } | null {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes(payload) <= MAX_PAYLOAD_BYTES) return payload;

  let trimmed = {
    ...payload,
    questions: payload.questions.map((question) => ({
      ...question,
      choices: question.choices.map(({ detail: _detail, ...rest }) => rest),
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
    if (picked.length === 0 && !answer?.custom?.trim()) {
      lines.push("  no answer given — treat this question as still open");
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

export default async function plugin(bb: BbPluginApi) {
  bb.agents.registerTool({
    name: "grill_round",
    description:
      "Put a whole round of grilling questions to the user as a form and wait for the answers. Each question carries its prose, your recommended answer, and the discrete options.",
    instructions:
      "When you are grilling the user — a round of numbered questions each with a recommended answer — submit the whole round through grill_round instead of printing the questions into the chat. Write the questions exactly as you otherwise would: the question body is the prose you would have written, and the recommendation is your recommended answer in your own words, which may combine options. Ask the entire frontier in one call. If the tool reports the round was cancelled, fall back to asking in plain chat.",
    presentation: {
      label: {
        pending: "Grilling — waiting for answers",
        completed: "Grilling round answered",
      },
    },
    parameters: roundSchema,
    async execute(input, { threadId, signal }) {
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
      let result;
      try {
        result = await bb.ui.requestInput(
          {
            threadId,
            rendererId: RENDERER_ID,
            title: `Grilling — ${payload.questions.length} question${
              payload.questions.length === 1 ? "" : "s"
            }`,
            payload: payload as never,
            timeoutMs: 60 * 60 * 1000,
          },
          { signal },
        );
      } catch (cause) {
        // The transport carrying this tool call can give up while the form is
        // still open — notably the host daemon's five-minute body timeout.
        // Say so plainly instead of crashing the turn.
        const detail = cause instanceof Error ? cause.message : String(cause);
        bb.log.warn(`round transport failed: ${detail}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `The form was still open when the connection carrying this call gave up (${detail}). Any answers the user was typing are lost. Ask this round in plain chat instead.`,
            },
          ],
          isError: true,
        };
      }

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
            parsed.success ? "answers do not match the round" : parsed.error.message
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

      return formatAnswers(payload.questions, parsed.data.answers);
    },
  });

  bb.log.info("grill ready");
}
