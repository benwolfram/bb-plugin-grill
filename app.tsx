import {
  Markdown,
  definePluginApp,
  useRpc,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { grillRpcContract, ImageAttachment } from "./server";

const CUSTOM_LABEL = "In your own words…";
const MAX_CUSTOM_CHARS = 500;
const DRAFT_STORAGE_PREFIX = "bb-grill-draft:";

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

type Payload = {
  intro?: string;
  questions: Question[];
};

type Answer = {
  choiceIds: string[];
  custom: string;
  customOn: boolean;
  images?: ImageAttachment[];
};

type StoredDraft = {
  answers: Record<string, Answer>;
  currentIndex?: number;
};

function parsePayload(raw: unknown): Payload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as { intro?: unknown; questions?: unknown };
  if (!Array.isArray(candidate.questions)) return null;

  const questions: Question[] = [];
  for (const q of candidate.questions) {
    if (typeof q !== "object" || q === null) return null;
    const { id, title, body, multiple, choices } = q as Record<string, unknown>;
    if (typeof id !== "string" || typeof title !== "string") return null;
    if (body !== undefined && typeof body !== "string") return null;
    if (typeof multiple !== "boolean") return null;
    if (!Array.isArray(choices)) return null;

    const parsedChoices: Choice[] = [];
    for (const c of choices) {
      if (typeof c !== "object" || c === null) return null;
      const {
        id: cid,
        label,
        detail,
        recommended,
      } = c as Record<string, unknown>;
      if (typeof cid !== "string" || typeof label !== "string") return null;
      if (detail !== undefined && typeof detail !== "string") return null;
      if (typeof recommended !== "boolean") return null;
      parsedChoices.push({
        id: cid,
        label,
        ...(detail ? { detail } : {}),
        recommended,
      });
    }
    questions.push({
      id,
      title,
      ...(body ? { body } : {}),
      multiple,
      choices: parsedChoices,
    });
  }

  return {
    ...(typeof candidate.intro === "string" ? { intro: candidate.intro } : {}),
    questions,
  };
}

function recommendedAnswers(questions: Question[]): Record<string, Answer> {
  const result: Record<string, Answer> = {};
  for (const q of questions) {
    const rec = q.choices.find((c) => c.recommended);
    result[q.id] = {
      choiceIds: rec ? [rec.id] : [],
      custom: "",
      customOn: false,
      images: [],
    };
  }
  return result;
}

function isAnswered(answer: Answer | undefined): boolean {
  if (!answer) return false;
  return (
    answer.choiceIds.length > 0 ||
    (answer.customOn &&
      (answer.custom.trim().length > 0 || (answer.images?.length ?? 0) > 0))
  );
}

function sameAsRecommended(
  questions: Question[],
  answers: Record<string, Answer>,
): boolean {
  const defaults = recommendedAnswers(questions);
  for (const q of questions) {
    const current = answers[q.id];
    const rec = defaults[q.id];
    if (!current || !rec) return false;
    if (
      current.customOn ||
      current.custom.trim() !== "" ||
      (current.images?.length ?? 0) > 0
    ) {
      return false;
    }
    if (current.choiceIds.length !== rec.choiceIds.length) return false;
    if (!current.choiceIds.every((id) => rec.choiceIds.includes(id)))
      return false;
  }
  return true;
}

function getSavedDraft(
  threadId: string,
  questions: Question[],
): { answers: Record<string, Answer>; currentIndex: number } | null {
  try {
    const raw = localStorage.getItem(`${DRAFT_STORAGE_PREFIX}${threadId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;

    let answersCandidate: Record<string, Answer> | null = null;
    let savedIndex = 0;

    if (
      "answers" in parsed &&
      typeof (parsed as StoredDraft).answers === "object"
    ) {
      answersCandidate = (parsed as StoredDraft).answers;
      if (typeof (parsed as StoredDraft).currentIndex === "number") {
        savedIndex = (parsed as StoredDraft).currentIndex!;
      }
    } else {
      answersCandidate = parsed as Record<string, Answer>;
    }

    if (!answersCandidate) return null;

    const allValid = questions.every((q) => {
      const a = answersCandidate![q.id];
      if (!a) return false;
      return (
        Array.isArray(a.choiceIds) &&
        typeof a.custom === "string" &&
        typeof a.customOn === "boolean"
      );
    });

    if (!allValid) return null;

    const validIndex =
      savedIndex >= 0 && savedIndex < questions.length ? savedIndex : 0;

    return { answers: answersCandidate, currentIndex: validIndex };
  } catch {
    return null;
  }
}

function saveDraft(
  threadId: string,
  answers: Record<string, Answer>,
  currentIndex: number,
): void {
  try {
    const data: StoredDraft = { answers, currentIndex };
    localStorage.setItem(
      `${DRAFT_STORAGE_PREFIX}${threadId}`,
      JSON.stringify(data),
    );
  } catch {
    // Ignore storage quota errors
  }
}

function clearDraft(threadId: string): void {
  try {
    localStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${threadId}`);
  } catch {
    // Ignore
  }
}

function RadioDot() {
  return <div className="size-2 rounded-full bg-primary" />;
}

function CheckmarkIcon() {
  return (
    <svg
      className="size-3 text-primary stroke-[3]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4.5 12.75l6 6 9-13.5"
      />
    </svg>
  );
}

function QuestionTabs({
  questions,
  currentIndex,
  answers,
  onSelect,
}: {
  questions: readonly Question[];
  currentIndex: number;
  answers: Record<string, Answer>;
  onSelect: (index: number) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Questions"
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-4 py-2"
    >
      {questions.map((question, index) => {
        const selected = index === currentIndex;
        const answered = isAnswered(answers[question.id]);
        return (
          <button
            key={question.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(index)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              selected
                ? "bg-primary text-primary-foreground shadow-xs"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <span>Q{index + 1}</span>
            {answered ? (
              <span
                className={cn(
                  "text-[10px]",
                  selected
                    ? "text-primary-foreground"
                    : "text-muted-foreground",
                )}
              >
                ✓
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function ChoiceRow({
  choice,
  index,
  isSelected,
  isMultiple,
  disabled,
  onToggle,
}: {
  choice: Choice;
  index: number;
  isSelected: boolean;
  isMultiple: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      role={isMultiple ? "checkbox" : "radio"}
      aria-checked={isSelected}
      tabIndex={disabled ? -1 : 0}
      onClick={() => {
        if (!disabled) onToggle();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onToggle();
        }
      }}
      className={cn(
        "group relative flex cursor-pointer select-none items-start gap-3 rounded-lg border p-3 transition-colors",
        isSelected
          ? "border-primary/40 bg-primary/5 text-foreground shadow-xs"
          : "border-border bg-card/50 hover:border-border-hover hover:bg-card/80 text-card-foreground",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors",
          isMultiple ? "rounded-xs" : "rounded-full",
          isSelected
            ? "border-primary bg-primary/10"
            : "border-muted-foreground/40 group-hover:border-muted-foreground/70",
        )}
      >
        {isSelected ? isMultiple ? <CheckmarkIcon /> : <RadioDot /> : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium leading-none">
            {choice.label}
          </span>
          {choice.recommended ? (
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
              Recommended
            </span>
          ) : null}
        </div>
        {choice.detail ? (
          <span className="mt-1 block text-xs text-muted-foreground leading-normal">
            {choice.detail}
          </span>
        ) : null}
      </div>

      {index < 9 ? (
        <kbd className="hidden sm:inline-flex h-5 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
          {index + 1}
        </kbd>
      ) : null}
    </div>
  );
}

function ImageThumbnail({
  img,
  threadId,
  rpc,
}: {
  img: ImageAttachment;
  threadId: string;
  rpc: ReturnType<typeof useRpc<typeof grillRpcContract>>;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    rpc
      .call("getImage", { threadId, imageId: img.id })
      .then((res) => {
        if (active) {
          setDataUrl(`data:${res.mimeType};base64,${res.dataBase64}`);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [img.id, rpc, threadId]);

  if (!dataUrl) {
    return (
      <div className="flex size-9 shrink-0 items-center justify-center rounded border border-border bg-muted">
        <Icon name="Spinner" className="size-3.5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <img
      src={dataUrl}
      alt={img.name}
      className="size-9 shrink-0 rounded border border-border object-cover"
    />
  );
}

function CustomChoiceRow({
  index,
  isSelected,
  isMultiple,
  disabled,
  customText,
  images,
  threadId,
  rpc,
  onToggle,
  onTextChange,
  onAddImage,
  onRemoveImage,
  customTextareaRef,
}: {
  index: number;
  isSelected: boolean;
  isMultiple: boolean;
  disabled: boolean;
  customText: string;
  images: ImageAttachment[];
  threadId: string;
  rpc: ReturnType<typeof useRpc<typeof grillRpcContract>>;
  onToggle: () => void;
  onTextChange: (text: string) => void;
  onAddImage: (image: ImageAttachment) => void;
  onRemoveImage: (imageId: string) => void;
  customTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [isUploading, setIsUploading] = useState(false);

  const resizeTextarea = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 64), 200)}px`;
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;

    e.preventDefault();

    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;

      const reader = new FileReader();
      reader.onload = async () => {
        const result = reader.result as string;
        const commaIndex = result.indexOf(",");
        const dataBase64 = commaIndex !== -1 ? result.slice(commaIndex + 1) : "";
        const mimeType = file.type || "image/png";
        const name =
          file.name && file.name !== "image.png"
            ? file.name
            : `screenshot-${Date.now()}.png`;

        try {
          setIsUploading(true);
          const saved = await rpc.call("saveImage", {
            threadId,
            dataBase64,
            mimeType,
            name,
          });
          onAddImage({
            id: saved.id,
            path: saved.path,
            name: saved.name,
            mimeType: saved.mimeType,
          });
        } catch (err) {
          console.error("Failed to save pasted image:", err);
        } finally {
          setIsUploading(false);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        role={isMultiple ? "checkbox" : "radio"}
        aria-checked={isSelected}
        tabIndex={disabled ? -1 : 0}
        onClick={() => {
          if (!disabled) onToggle();
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            onToggle();
          }
        }}
        className={cn(
          "group relative flex cursor-pointer select-none items-start gap-3 rounded-lg border p-3 transition-colors",
          isSelected
            ? "border-primary/40 bg-primary/5 text-foreground shadow-xs"
            : "border-border bg-card/50 hover:border-border-hover hover:bg-card/80 text-card-foreground",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        <div
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors",
            isMultiple ? "rounded-xs" : "rounded-full",
            isSelected
              ? "border-primary bg-primary/10"
              : "border-muted-foreground/40 group-hover:border-muted-foreground/70",
          )}
        >
          {isSelected ? isMultiple ? <CheckmarkIcon /> : <RadioDot /> : null}
        </div>

        <span className="min-w-0 flex-1 text-sm font-medium leading-none text-muted-foreground">
          {CUSTOM_LABEL}
        </span>

        {index < 9 ? (
          <kbd className="hidden sm:inline-flex h-5 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
            {index + 1}
          </kbd>
        ) : null}
      </div>

      {isSelected ? (
        <div className="flex flex-col gap-2">
          <textarea
            ref={customTextareaRef}
            value={customText}
            disabled={disabled}
            maxLength={MAX_CUSTOM_CHARS}
            onPaste={handlePaste}
            onChange={(e) => {
              onTextChange(e.target.value);
              resizeTextarea(e.target);
            }}
            placeholder="Type your own answer, or paste a screenshot…"
            className="w-full resize-none overflow-y-auto rounded-md border border-border bg-surface-raised px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:border-ring/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
            style={{ minHeight: "64px", maxHeight: "200px" }}
          />

          {(images.length > 0 || isUploading) ? (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {images.map((img) => (
                <div
                  key={img.id}
                  className="group relative flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-1.5 pr-2 shadow-xs transition-colors hover:bg-muted/60"
                >
                  <ImageThumbnail img={img} threadId={threadId} rpc={rpc} />
                  <div className="flex flex-col max-w-[150px]">
                    <span className="truncate text-xs font-medium text-foreground">
                      {img.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground uppercase">
                      {img.mimeType.split("/")[1] ?? "image"}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveImage(img.id);
                    }}
                    className="ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    title="Remove image"
                  >
                    <Icon name="X" className="size-3.5" />
                  </button>
                </div>
              ))}

              {isUploading ? (
                <div className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                  <Icon name="Spinner" className="size-3.5 animate-spin" />
                  <span>Saving image…</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
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
  const rpc = useRpc<typeof grillRpcContract>();

  const payload = useMemo(
    () => parsePayload(interaction.payload),
    [interaction.payload],
  );
  const questions = useMemo(() => payload?.questions ?? [], [payload]);
  const totalQuestions = questions.length;

  const initialDraft = useMemo(
    () => getSavedDraft(interaction.threadId, questions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [currentIndex, setCurrentIndex] = useState<number>(
    () => initialDraft?.currentIndex ?? 0,
  );
  const [answers, setAnswers] = useState<Record<string, Answer>>(
    () => initialDraft?.answers ?? recommendedAnswers(questions),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customTextareaRef = useRef<HTMLTextAreaElement>(null);
  const currentQuestion = questions[currentIndex] ?? null;

  const complete = useMemo(
    () =>
      totalQuestions > 0 &&
      questions.every((question) => isAnswered(answers[question.id])),
    [answers, questions, totalQuestions],
  );

  const isFirst = currentIndex === 0;
  const isLast = currentIndex === totalQuestions - 1;
  const dirty = !sameAsRecommended(questions, answers);

  const updateAnswers = useCallback(
    (updater: (prev: Record<string, Answer>) => Record<string, Answer>) => {
      setAnswers((prev) => {
        const next = updater(prev);
        saveDraft(interaction.threadId, next, currentIndex);
        return next;
      });
    },
    [currentIndex, interaction.threadId],
  );

  const selectTab = useCallback(
    (index: number) => {
      setCurrentIndex(index);
      saveDraft(interaction.threadId, answers, index);
    },
    [answers, interaction.threadId],
  );

  const toggleChoice = useCallback(
    (questionId: string, choiceId: string, isMultiple: boolean) => {
      updateAnswers((prev) => {
        const current = prev[questionId] ?? {
          choiceIds: [],
          custom: "",
          customOn: false,
          images: [],
        };
        if (isMultiple) {
          const choiceIds = current.choiceIds.includes(choiceId)
            ? current.choiceIds.filter((id) => id !== choiceId)
            : [...current.choiceIds, choiceId];
          return { ...prev, [questionId]: { ...current, choiceIds } };
        }
        return {
          ...prev,
          [questionId]: {
            ...current,
            choiceIds: [choiceId],
            customOn: false,
          },
        };
      });
    },
    [updateAnswers],
  );

  const toggleCustom = useCallback(
    (questionId: string, isMultiple: boolean) => {
      updateAnswers((prev) => {
        const current = prev[questionId] ?? {
          choiceIds: [],
          custom: "",
          customOn: false,
          images: [],
        };
        if (isMultiple) {
          return {
            ...prev,
            [questionId]: { ...current, customOn: !current.customOn },
          };
        }
        const nextOn = !current.customOn;
        return {
          ...prev,
          [questionId]: {
            ...current,
            customOn: nextOn,
            choiceIds: nextOn ? [] : current.choiceIds,
          },
        };
      });
      setTimeout(() => customTextareaRef.current?.focus(), 50);
    },
    [updateAnswers],
  );

  const setCustomText = useCallback(
    (questionId: string, text: string) => {
      updateAnswers((prev) => {
        const current = prev[questionId] ?? {
          choiceIds: [],
          custom: "",
          customOn: true,
          images: [],
        };
        return {
          ...prev,
          [questionId]: { ...current, custom: text, customOn: true },
        };
      });
    },
    [updateAnswers],
  );

  const addImage = useCallback(
    (questionId: string, image: ImageAttachment) => {
      updateAnswers((prev) => {
        const current = prev[questionId] ?? {
          choiceIds: [],
          custom: "",
          customOn: true,
          images: [],
        };
        return {
          ...prev,
          [questionId]: {
            ...current,
            customOn: true,
            images: [...(current.images ?? []), image],
          },
        };
      });
    },
    [updateAnswers],
  );

  const removeImage = useCallback(
    (questionId: string, imageId: string) => {
      updateAnswers((prev) => {
        const current = prev[questionId];
        if (!current) return prev;
        return {
          ...prev,
          [questionId]: {
            ...current,
            images: (current.images ?? []).filter((img) => img.id !== imageId),
          },
        };
      });
      void rpc
        .call("deleteImage", { threadId: interaction.threadId, imageId })
        .catch(() => {});
    },
    [interaction.threadId, rpc, updateAnswers],
  );

  const send = useCallback(async () => {
    if (pending || !complete) return;
    setPending(true);
    setError(null);
    try {
      await submit({
        answers: questions.map((question) => {
          const answer = answers[question.id];
          const custom = answer?.customOn ? answer.custom.trim() : "";
          const images = answer?.customOn ? answer.images : undefined;
          return {
            id: question.id,
            choiceIds: answer?.choiceIds ?? [],
            ...(custom === "" ? {} : { custom }),
            ...(images && images.length > 0 ? { images } : {}),
          };
        }),
      });
      clearDraft(interaction.threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  }, [answers, complete, interaction.threadId, pending, questions, submit]);

  const handleAdvance = useCallback(() => {
    if (isLast) {
      void send();
      return;
    }
    selectTab(Math.min(currentIndex + 1, totalQuestions - 1));
  }, [currentIndex, isLast, selectTab, send, totalQuestions]);

  const handleDismiss = useCallback(async () => {
    clearDraft(interaction.threadId);
    await cancel();
  }, [cancel, interaction.threadId]);

  // Keyboard shortcuts: 1-9 for choices
  useEffect(() => {
    if (pending || currentQuestion === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement)
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) {
        return;
      }
      const choiceIndex = digit - 1;
      if (choiceIndex < currentQuestion.choices.length) {
        event.preventDefault();
        const choice = currentQuestion.choices[choiceIndex]!;
        toggleChoice(currentQuestion.id, choice.id, currentQuestion.multiple);
      } else if (choiceIndex === currentQuestion.choices.length) {
        event.preventDefault();
        toggleCustom(currentQuestion.id, currentQuestion.multiple);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, currentQuestion, toggleChoice, toggleCustom]);

  if (payload === null) {
    return (
      <Dismissable
        message="This grilling round arrived in a shape this plugin does not understand."
        cancel={cancel}
      />
    );
  }

  if (!currentQuestion) return null;

  const currentAnswer =
    answers[currentQuestion.id] ??
    recommendedAnswers([currentQuestion])[currentQuestion.id]!;

  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (complete) {
        void send();
      } else {
        handleAdvance();
      }
    }
  };

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        handleAdvance();
      }}
      onKeyDown={onFormKeyDown}
      className="flex max-h-[85dvh] min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
    >
      {totalQuestions > 1 ? (
        <QuestionTabs
          questions={questions}
          currentIndex={currentIndex}
          answers={answers}
          onSelect={selectTab}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        {payload.intro && isFirst ? (
          <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <Markdown content={payload.intro} />
          </div>
        ) : null}

        <fieldset className="min-w-0 space-y-3">
          <legend className="flex items-baseline gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              Q{currentIndex + 1}/{totalQuestions}
            </span>
            <span className="text-sm font-semibold text-foreground">
              {currentQuestion.title}
            </span>
            {currentQuestion.multiple ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                Multiple choice
              </span>
            ) : null}
          </legend>

          {currentQuestion.body ? (
            <div className="text-xs text-muted-foreground leading-relaxed">
              <Markdown content={currentQuestion.body} />
            </div>
          ) : null}

          <div className="flex flex-col gap-2 pt-1">
            {currentQuestion.choices.map((choice, idx) => (
              <ChoiceRow
                key={choice.id}
                choice={choice}
                index={idx}
                isSelected={currentAnswer.choiceIds.includes(choice.id)}
                isMultiple={currentQuestion.multiple}
                disabled={pending}
                onToggle={() =>
                  toggleChoice(
                    currentQuestion.id,
                    choice.id,
                    currentQuestion.multiple,
                  )
                }
              />
            ))}

            <CustomChoiceRow
              index={currentQuestion.choices.length}
              isSelected={currentAnswer.customOn}
              isMultiple={currentQuestion.multiple}
              disabled={pending}
              customText={currentAnswer.custom}
              images={currentAnswer.images ?? []}
              threadId={interaction.threadId}
              rpc={rpc}
              onToggle={() =>
                toggleCustom(currentQuestion.id, currentQuestion.multiple)
              }
              onTextChange={(text) => setCustomText(currentQuestion.id, text)}
              onAddImage={(img) => addImage(currentQuestion.id, img)}
              onRemoveImage={(imgId) => removeImage(currentQuestion.id, imgId)}
              customTextareaRef={customTextareaRef}
            />
          </div>
        </fieldset>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => void handleDismiss()}
        >
          Dismiss
        </Button>

        <div className="flex min-w-0 flex-1 items-center justify-center gap-3">
          {dirty ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                const rec = recommendedAnswers(questions);
                setAnswers(rec);
                saveDraft(interaction.threadId, rec, currentIndex);
              }}
            >
              Reset to recommendations
            </Button>
          ) : null}

          {error ? (
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {!isFirst ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => selectTab(Math.max(currentIndex - 1, 0))}
            >
              Back
            </Button>
          ) : null}

          <Button
            type="button"
            size="sm"
            disabled={pending || (isLast && !complete)}
            onClick={handleAdvance}
          >
            {pending ? (
              <Icon name="Spinner" className="size-3 animate-spin" />
            ) : null}
            {isLast ? (pending ? "Submitting…" : "Submit") : "Next"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function GrillRoundSlot(props: PluginPendingInteractionProps) {
  return <GrillRound {...props} />;
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: "grill-round",
    component: GrillRoundSlot,
  });
});
