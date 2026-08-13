import { describe, expect, it } from "vitest";
import {
  ASK_QUESTION_OTHER_ID,
  askQuestionAnswersComplete,
  formatAskQuestionResult,
  parseAskQuestionInput,
  validateAskQuestionAnswers,
  type AskQuestion,
} from "../chat/ask-question";

const selection = {
  id: "region",
  prompt: "Which region?",
  type: "selection",
  options: [
    { id: "eu", label: "EU" },
    { id: "us", label: "US" },
  ],
} as const satisfies AskQuestion;

const text = { id: "notes", prompt: "Anything else?", type: "text" } as const satisfies AskQuestion;

describe("parseAskQuestionInput", () => {
  it("accepts mixed selection and text questions", () => {
    const parsed = parseAskQuestionInput({ questions: [selection, text] });
    expect(parsed).toEqual({ ok: true, questions: [selection, text] });
  });

  it("fills a missing question id", () => {
    const parsed = parseAskQuestionInput({
      questions: [{ prompt: "Name?", type: "text" }],
    });
    expect(parsed).toEqual({
      ok: true,
      questions: [{ id: "q1", prompt: "Name?", type: "text" }],
    });
  });

  it("rejects a reserved Other option id", () => {
    const parsed = parseAskQuestionInput({
      questions: [
        {
          ...selection,
          options: [
            { id: "other", label: "Something else" },
            { id: "us", label: "US" },
          ],
        },
      ],
    });
    expect(parsed.ok).toBe(false);
  });

  it("rejects a selection with fewer than two options", () => {
    const parsed = parseAskQuestionInput({
      questions: [{ ...selection, options: [{ id: "eu", label: "EU" }] }],
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("validateAskQuestionAnswers", () => {
  const questions = [selection, text];

  it("accepts a listed option plus a textarea", () => {
    const result = validateAskQuestionAnswers(questions, [
      { questionId: "region", optionId: "eu" },
      { questionId: "notes", text: "staging VPC" },
    ]);
    expect(result).toEqual({
      ok: true,
      answers: [
        { questionId: "region", optionId: "eu" },
        { questionId: "notes", text: "staging VPC" },
      ],
    });
  });

  it("accepts Other with text", () => {
    const result = validateAskQuestionAnswers(
      [selection],
      [{ questionId: "region", optionId: ASK_QUESTION_OTHER_ID, text: "ap-south-1" }],
    );
    expect(result.ok).toBe(true);
  });

  it("rejects Other without text", () => {
    const result = validateAskQuestionAnswers(
      [selection],
      [{ questionId: "region", optionId: ASK_QUESTION_OTHER_ID }],
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown option", () => {
    const result = validateAskQuestionAnswers(
      [selection],
      [{ questionId: "region", optionId: "mars" }],
    );
    expect(result.ok).toBe(false);
  });
});

describe("askQuestionAnswersComplete / formatAskQuestionResult", () => {
  it("treats a partial draft as incomplete", () => {
    const complete = askQuestionAnswersComplete(
      [selection, text],
      new Map([["region", { optionId: "eu" }]]),
    );
    expect(complete).toBe(false);
  });

  it("formats listed labels and Other text for the model", () => {
    const text = formatAskQuestionResult(
      [selection],
      [{ questionId: "region", optionId: ASK_QUESTION_OTHER_ID, text: "ap-south-1" }],
    );
    expect(text).toBe("Which region?\nap-south-1");
  });
});
