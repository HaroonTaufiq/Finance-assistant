import { SuggestCutbacksOutput } from "@/lib/contracts/tools";

export function parseCutbacksOutput(text: string) {
  const json = text.replace(/```(?:json)?|```/gi, "").trim();
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error("Cutback suggestions returned invalid JSON", { cause: error });
  }

  const parsed = SuggestCutbacksOutput.safeParse({ suggestions: value });
  if (!parsed.success) {
    throw new Error("Cutback suggestions returned an invalid shape", { cause: parsed.error });
  }
  return parsed.data.suggestions;
}
