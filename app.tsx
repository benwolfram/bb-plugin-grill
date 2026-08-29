// bb-plugin-grill — the frontend entry.
//
// One slot: the pending-interaction form that replaces the thread composer
// while `grill_round` is waiting. The whole round of questions is answered
// in one place, and the mount state is already "I agree with every
// recommendation", so the common case is a single click on Submit.
//
// The payload types below mirror what server.ts sends. They are duplicated on
// purpose: the backend module is erased from this bundle, so nothing here may
// import it.
import { useCallback, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  definePluginApp,
  Markdown,
  type JsonValue,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { ChoiceControl, ChoiceRow } from "@/components/ui/choice";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Choice = {
  id: string;
  label: string;
  detail?: string;
  recommended: boolean;
};

type Question = {
  id: string;
  title: string;
  body?: string;
  multiple: boolean;
  choices: Choice[];
};

type Payload = { intro?: string; questions: Question[] };

/** Per-question form state. `custom` survives unticking "Something else…". */
type Answer = { choiceIds: string[]; customOn: boolean; custom: string };

const CUSTOM_LABEL = "Something else…";
/** Matches the backend's per-answer ceiling, so Submit can never be rejected. */
const MAX_CUSTOM_CHARS = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

/**
 * Read the interaction payload defensively. Returns null for anything that is
 * not the shape server.ts produces, so the form can say so instead of
 * throwing inside the composer.
 */
function parsePayload(value: JsonValue): Payload | null {
  if (!isRecord(value)) return null;
  const intro = optionalString(value.intro);
  if (intro === null) return null;
  if (!Array.isArray(value.questions) || value.questions.length === 0) {
    return null;
  }
  const questions: Question[] = [];
  for (const raw of value.questions) {
    if (!isRecord(raw)) return null;
    if (typeof raw.id !== "string" || typeof raw.title !== "string") {
      return null;
    }
    const body = optionalString(raw.body);
    if (body === null) return null;
    if (!Array.isArray(raw.choices) || raw.choices.length === 0) return null;
    const choices: Choice[] = [];
    for (const rawChoice of raw.choices) {
      if (!isRecord(rawChoice)) return null;
      if (
        typeof rawChoice.id !== "string" ||
        typeof rawChoice.label !== "string"
      ) {
        return null;
      }
      const detail = optionalString(rawChoice.detail);
      if (detail === null) return null;
      choices.push({
        id: rawChoice.id,
        label: rawChoice.label,
        ...(detail === undefined ? {} : { detail }),
        recommended: rawChoice.recommended === true,
      });
    }
    questions.push({
      id: raw.id,
      title: raw.title,
      ...(body === undefined ? {} : { body }),
      multiple: raw.multiple === true,
      choices,
    });
  }
  return { ...(intro === undefined ? {} : { intro }), questions };
}

/** Every recommendation selected, nothing typed — the mount state. */
function recommendedAnswers(questions: Question[]): Record<string, Answer> {
  const initial: Record<string, Answer> = {};
  for (const question of questions) {
    const recommended = question.choices.filter((choice) => choice.recommended);
    const picked = recommended.length > 0 ? recommended : question.choices.slice(0, 1);
    initial[question.id] = {
      choiceIds: picked.map((choice) => choice.id),
      customOn: false,
      custom: "",
    };
  }
  return initial;
}

/** A question is answered when something is ticked, or custom text is typed. */
function isAnswered(answer: Answer | undefined): boolean {
  if (!answer) return false;
  if (answer.choiceIds.length > 0) return true;
  return answer.customOn && answer.custom.trim() !== "";
}

function sameAsRecommended(
  questions: Question[],
  answers: Record<string, Answer>,
): boolean {
  const initial = recommendedAnswers(questions);
  return questions.every((question) => {
    const now = answers[question.id];
    const then = initial[question.id];
    if (!now || !then) return false;
    if (now.customOn || now.custom !== "") return false;
    if (now.choiceIds.length !== then.choiceIds.length) return false;
    return now.choiceIds.every((id, index) => id === then.choiceIds[index]);
  });
}

function ChoiceBody({ choice }: { choice: Choice }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span>{choice.label}</span>
        {choice.recommended ? (
          <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
            Recommended
          </span>
        ) : null}
      </span>
      {choice.detail ? (
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {choice.detail}
        </span>
      ) : null}
    </span>
  );
}

function QuestionBlock({
  question,
  index,
  answer,
  onChange,
}: {
  question: Question;
  index: number;
  answer: Answer;
  onChange: (next: Answer) => void;
}) {
  const customId = `${question.id}-custom`;
  const toggle = (choiceId: string, checked: boolean) => {
    if (question.multiple) {
      onChange({
        ...answer,
        choiceIds: checked
          ? [...answer.choiceIds, choiceId]
          : answer.choiceIds.filter((id) => id !== choiceId),
      });
      return;
    }
    onChange({ ...answer, choiceIds: [choiceId], customOn: false });
  };
  const toggleCustom = (checked: boolean) => {
    if (question.multiple) {
      onChange({ ...answer, customOn: checked });
      return;
    }
    onChange({
      ...answer,
      customOn: checked,
      choiceIds: checked ? [] : answer.choiceIds,
    });
  };
  return (
    <fieldset className="min-w-0">
      <legend className="flex items-baseline gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          Q{index + 1}
        </span>
        <span className="text-sm font-medium">{question.title}</span>
      </legend>
      {question.body ? (
        <div className="mt-1.5 text-sm text-muted-foreground">
          <Markdown content={question.body} />
        </div>
      ) : null}
      <div className="mt-2 flex flex-col gap-0.5">
        {question.choices.map((choice) => (
          <ChoiceRow key={choice.id}>
            <ChoiceControl
              multiple={question.multiple}
              name={question.multiple ? undefined : `${question.id}-choice`}
              checked={answer.choiceIds.includes(choice.id)}
              onChange={(event) => toggle(choice.id, event.target.checked)}
            />
            <ChoiceBody choice={choice} />
          </ChoiceRow>
        ))}
        <ChoiceRow>
          <ChoiceControl
            multiple={question.multiple}
            name={question.multiple ? undefined : `${question.id}-choice`}
            checked={answer.customOn}
            onChange={(event) => toggleCustom(event.target.checked)}
          />
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">
            {CUSTOM_LABEL}
          </span>
        </ChoiceRow>
      </div>
      {answer.customOn ? (
        <div className="mt-2">
          <label htmlFor={customId} className="sr-only">
            Your own answer to “{question.title}”
          </label>
          <Textarea
            id={customId}
            rows={2}
            maxLength={MAX_CUSTOM_CHARS}
            value={answer.custom}
            placeholder="In your own words…"
            onChange={(event) =>
              onChange({ ...answer, custom: event.target.value })
            }
          />
        </div>
      ) : null}
    </fieldset>
  );
}

function Dismissable({
  message,
  cancel,
}: {
  message: string;
  cancel: () => Promise<void>;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <p role="alert" className="text-sm text-muted-foreground">
        {message}
      </p>
      <Button variant="outline" size="sm" onClick={() => void cancel()}>
        Dismiss
      </Button>
    </div>
  );
}

function GrillRound({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const payload = useMemo(
    () => parsePayload(interaction.payload),
    [interaction.payload],
  );
  const questions = payload?.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, Answer>>(() =>
    recommendedAnswers(questions),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const complete =
    questions.length > 0 &&
    questions.every((question) => isAnswered(answers[question.id]));
  const dirty = !sameAsRecommended(questions, answers);

  const send = useCallback(async () => {
    if (pending || !complete) return;
    setPending(true);
    setError(null);
    try {
      await submit({
        answers: questions.map((question) => {
          const answer = answers[question.id];
          const custom = answer?.customOn ? answer.custom.trim() : "";
          return {
            id: question.id,
            choiceIds: answer?.choiceIds ?? [],
            ...(custom === "" ? {} : { custom }),
          };
        }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  }, [answers, complete, pending, questions, submit]);

  if (payload === null) {
    return (
      <Dismissable
        message="This grilling round arrived in a shape this plugin does not understand."
        cancel={cancel}
      />
    );
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      className="flex max-h-[60vh] min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="shrink-0 border-b border-border px-4 py-3">
        <p className="text-sm font-medium">
          {questions.length} question{questions.length === 1 ? "" : "s"}
        </p>
        {payload.intro ? (
          <div className="mt-1 text-sm text-muted-foreground">
            <Markdown content={payload.intro} />
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-3">
        {questions.map((question, index) => (
          <QuestionBlock
            key={question.id}
            question={question}
            index={index}
            answer={answers[question.id] ?? recommendedAnswers([question])[question.id]!}
            onChange={(next) =>
              setAnswers((current) => ({ ...current, [question.id]: next }))
            }
          />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
        <Button type="submit" size="sm" disabled={pending || !complete}>
          {pending ? "Submitting…" : "Submit"}
        </Button>
        {dirty ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="px-0 text-muted-foreground"
            onClick={() => setAnswers(recommendedAnswers(questions))}
          >
            Reset to recommendations
          </Button>
        ) : null}
        <span className="min-w-0 flex-1">
          {error === null ? null : (
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          )}
          {error === null && !complete ? (
            <span className="text-xs text-muted-foreground">
              Answer every question to submit.
            </span>
          ) : null}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("text-muted-foreground")}
          disabled={pending}
          onClick={() => void cancel()}
        >
          Dismiss
        </Button>
      </div>
    </form>
  );
}

/**
 * The host may hand the same slot instance a second round. Keying on the
 * interaction id remounts the form, so no selection, typed text, or in-flight
 * "Submitting…" state can leak from one round into the next.
 */
function GrillRoundSlot(props: PluginPendingInteractionProps) {
  return <GrillRound key={props.interaction.id} {...props} />;
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: "grill-round",
    component: GrillRoundSlot,
  });
});
