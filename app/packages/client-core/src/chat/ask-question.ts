/**
 * Chat-only `ask_question` tool: the in-app agent pauses for a structured
 * answer (radio selection + Other, or a textarea) instead of asking in prose.
 *
 * Shared between the server (parse on tool_use, validate on submit) and the
 * clients (render the form, disable Submit until complete). Deliberately not
 * in the MCP registry — an MCP host already has its own way to ask the user.
 */

export const ASK_QUESTION_TOOL_NAME = "ask_question";
/** Reserved option id the UI always appends to selection questions. */
export const ASK_QUESTION_OTHER_ID = "other";

export const ASK_QUESTION_LIMITS = {
  maxQuestions: 8,
  minOptions: 2,
  maxOptions: 12,
  maxIdLength: 64,
  maxPromptLength: 500,
  maxLabelLength: 200,
  maxAnswerLength: 4000,
} as const;

export type AskQuestionType = "selection" | "text";

export interface AskQuestionOption {
  id: string;
  label: string;
}

export interface AskQuestion {
  id: string;
  prompt: string;
  type: AskQuestionType;
  /** Present when `type` is `selection`. The UI always adds an Other field. */
  options?: AskQuestionOption[];
}

export interface AskQuestionAnswer {
  questionId: string;
  /** Listed option id, or `other`. Omitted for `text` questions. */
  optionId?: string;
  /** Required for `text` questions and when `optionId` is `other`. */
  text?: string;
}

export type AskQuestionParseResult =
  { ok: true; questions: AskQuestion[] } | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function parseId(value: unknown): string | null {
  return trimString(value, ASK_QUESTION_LIMITS.maxIdLength);
}

function parseOption(value: unknown): AskQuestionOption | string {
  if (typeof value === "string") {
    const label = trimString(value, ASK_QUESTION_LIMITS.maxLabelLength);
    if (!label) return "Each option needs a non-empty label.";
    if (label.toLowerCase() === ASK_QUESTION_OTHER_ID) {
      return `Option id "${ASK_QUESTION_OTHER_ID}" is reserved for the Other field.`;
    }
    return { id: label, label };
  }
  const rec = asRecord(value);
  if (!rec) return "Each option must be an object with id and label.";
  const id = parseId(rec["id"] ?? rec["label"]);
  const label = trimString(rec["label"] ?? rec["id"], ASK_QUESTION_LIMITS.maxLabelLength);
  if (!id || !label) return "Each option needs a non-empty id and label.";
  if (id.toLowerCase() === ASK_QUESTION_OTHER_ID) {
    return `Option id "${ASK_QUESTION_OTHER_ID}" is reserved for the Other field.`;
  }
  return { id, label };
}

function parseQuestion(value: unknown, index: number): AskQuestion | string {
  const rec = asRecord(value);
  if (!rec) return `Question ${index + 1} must be an object.`;
  const id = parseId(rec["id"]) ?? `q${index + 1}`;
  const prompt = trimString(rec["prompt"], ASK_QUESTION_LIMITS.maxPromptLength);
  if (!prompt) {
    return `Question ${index + 1} needs a non-empty prompt (max ${ASK_QUESTION_LIMITS.maxPromptLength} characters).`;
  }
  const rawType = rec["type"];
  if (rawType !== "selection" && rawType !== "text") {
    return `Question ${index + 1} type must be "selection" or "text".`;
  }
  if (rawType === "text") {
    return { id, prompt, type: "text" };
  }
  const rawOptions = rec["options"];
  if (!Array.isArray(rawOptions)) {
    return `Question ${index + 1} is a selection and needs an options array.`;
  }
  if (
    rawOptions.length < ASK_QUESTION_LIMITS.minOptions ||
    rawOptions.length > ASK_QUESTION_LIMITS.maxOptions
  ) {
    return `Question ${index + 1} needs between ${ASK_QUESTION_LIMITS.minOptions} and ${ASK_QUESTION_LIMITS.maxOptions} options.`;
  }
  const options: AskQuestionOption[] = [];
  const seen = new Set<string>();
  for (const raw of rawOptions) {
    const option = parseOption(raw);
    if (typeof option === "string") return `Question ${index + 1}: ${option}`;
    const key = option.id.toLowerCase();
    if (seen.has(key)) return `Question ${index + 1} has a duplicate option id "${option.id}".`;
    seen.add(key);
    options.push(option);
  }
  return { id, prompt, type: "selection", options };
}

/**
 * Canonicalise a model `ask_question` tool_use input. On success the questions
 * array is what we persist as `chat_pending_actions.tool_input` and render.
 */
export function parseAskQuestionInput(input: unknown): AskQuestionParseResult {
  const rec = asRecord(input);
  if (!rec) return { ok: false, error: "ask_question input must be an object." };
  const raw = rec["questions"];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "ask_question needs a non-empty questions array." };
  }
  if (raw.length > ASK_QUESTION_LIMITS.maxQuestions) {
    return {
      ok: false,
      error: `ask_question accepts at most ${ASK_QUESTION_LIMITS.maxQuestions} questions per call.`,
    };
  }
  const questions: AskQuestion[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const parsed = parseQuestion(raw[i], i);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    const key = parsed.id.toLowerCase();
    if (seen.has(key)) {
      return { ok: false, error: `Duplicate question id "${parsed.id}".` };
    }
    seen.add(key);
    questions.push(parsed);
  }
  return { ok: true, questions };
}

function parseAnswer(value: unknown): AskQuestionAnswer | string {
  const rec = asRecord(value);
  if (!rec) return "Each answer must be an object.";
  const questionId = parseId(rec["questionId"]);
  if (!questionId) return "Each answer needs a questionId.";
  const optionId =
    rec["optionId"] === undefined || rec["optionId"] === null
      ? undefined
      : parseId(rec["optionId"]);
  if (rec["optionId"] !== undefined && rec["optionId"] !== null && !optionId) {
    return `Answer for "${questionId}" has an empty optionId.`;
  }
  const text =
    rec["text"] === undefined || rec["text"] === null
      ? undefined
      : typeof rec["text"] === "string"
        ? rec["text"].trim()
        : null;
  if (text === null) return `Answer for "${questionId}" text must be a string.`;
  if (text !== undefined && text.length > ASK_QUESTION_LIMITS.maxAnswerLength) {
    return `Answer for "${questionId}" is longer than ${ASK_QUESTION_LIMITS.maxAnswerLength} characters.`;
  }
  return {
    questionId,
    ...(optionId ? { optionId } : {}),
    ...(text ? { text } : {}),
  };
}

export type AskQuestionAnswersResult =
  { ok: true; answers: AskQuestionAnswer[] } | { ok: false; error: string };

/**
 * Check submitted answers against the questions that were shown. Unknown ids,
 * missing questions, and Other/text without body all fail closed.
 */
export function validateAskQuestionAnswers(
  questions: AskQuestion[],
  rawAnswers: unknown,
): AskQuestionAnswersResult {
  if (!Array.isArray(rawAnswers)) {
    return { ok: false, error: "`answers` must be an array." };
  }
  const parsed: AskQuestionAnswer[] = [];
  const seen = new Set<string>();
  for (const raw of rawAnswers) {
    const answer = parseAnswer(raw);
    if (typeof answer === "string") return { ok: false, error: answer };
    const key = answer.questionId.toLowerCase();
    if (seen.has(key)) {
      return { ok: false, error: `Duplicate answer for "${answer.questionId}".` };
    }
    seen.add(key);
    parsed.push(answer);
  }

  const byId = new Map(parsed.map((a) => [a.questionId, a]));
  const canonical: AskQuestionAnswer[] = [];
  for (const question of questions) {
    const answer = byId.get(question.id);
    if (!answer) {
      return { ok: false, error: `Missing answer for "${question.id}".` };
    }
    if (question.type === "text") {
      const text = answer.text?.trim() ?? "";
      if (!text) return { ok: false, error: `Question "${question.id}" needs a text answer.` };
      canonical.push({ questionId: question.id, text });
      continue;
    }
    const optionId = answer.optionId;
    if (!optionId) {
      return { ok: false, error: `Question "${question.id}" needs a selected option.` };
    }
    if (optionId === ASK_QUESTION_OTHER_ID) {
      const text = answer.text?.trim() ?? "";
      if (!text) {
        return { ok: false, error: `Question "${question.id}" Other option needs a text value.` };
      }
      canonical.push({ questionId: question.id, optionId, text });
      continue;
    }
    const match = question.options?.find((o) => o.id === optionId);
    if (!match) {
      return { ok: false, error: `Question "${question.id}" has unknown option "${optionId}".` };
    }
    canonical.push({ questionId: question.id, optionId });
  }
  return { ok: true, answers: canonical };
}

/** True when every question has a value the server would accept. */
export function askQuestionAnswersComplete(
  questions: AskQuestion[],
  answers: ReadonlyMap<string, { optionId?: string; text?: string }>,
): boolean {
  const payload = questions.map((question) => {
    const draft = answers.get(question.id) ?? {};
    return {
      questionId: question.id,
      ...(draft.optionId ? { optionId: draft.optionId } : {}),
      ...(draft.text ? { text: draft.text } : {}),
    };
  });
  return validateAskQuestionAnswers(questions, payload).ok;
}

function answerDisplay(question: AskQuestion, answer: AskQuestionAnswer): string {
  if (question.type === "text") return answer.text ?? "";
  if (answer.optionId === ASK_QUESTION_OTHER_ID) return answer.text ?? "";
  const match = question.options?.find((o) => o.id === answer.optionId);
  return match?.label ?? answer.optionId ?? "";
}

/** Tool-result text the model reads after the user submits. */
export function formatAskQuestionResult(
  questions: AskQuestion[],
  answers: AskQuestionAnswer[],
): string {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  return questions
    .map((question) => {
      const answer = byId.get(question.id);
      const value = answer ? answerDisplay(question, answer) : "(unanswered)";
      return `${question.prompt}\n${value}`;
    })
    .join("\n\n");
}
