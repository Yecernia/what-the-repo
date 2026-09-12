/** Keep a submitted draft intact while repairing only schema-rejected text fields. */
import { Type, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { Guard } from "typebox/guard";

export const TEXT_REPAIR_TOOL = "repair_result_text";
export const TEXT_REPAIR_SCHEMA = Type.Object({
  draft_id: Type.Integer({ minimum: 1 }),
  corrections: Type.Array(Type.Object({
    field_id: Type.String({ minLength: 1 }),
    value: Type.String(),
  }), { minItems: 1, maxItems: 128 }),
});

export const TEXT_REPAIR_DEFINITION = {
  name: TEXT_REPAIR_TOOL,
  description: "仅在submit_result反馈已保存草稿时调用。核对反馈中的对象身份和current_text，使用最新draft_id和错误字段field_id，只改该对象的原文以符合长度要求；不得串用相邻对象的说明。其余结果由程序原样保留并完整校验。",
  parameters: TEXT_REPAIR_SCHEMA,
};

export interface TextRepairStats {
  drafts: number;
  attempts: number;
  appliedFields: number;
  exhausted: boolean;
  remainingFields: Array<{ location: string; rule: string; limit: number; currentLength: number }>;
}

type Field = { path: string[]; field_id: string; location: string; limit: number; rule: string };

function readPath(value: unknown, path: string[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export class TextSubmissionRepair<T extends TSchema> {
  private readonly check;
  private readonly allowed: Set<string>;
  private draft: unknown = null;
  private revision = 0;
  private fields: Field[] = [];
  readonly stats: TextRepairStats = { drafts: 0, attempts: 0, appliedFields: 0, exhausted: false, remainingFields: [] };

  constructor(private readonly schema: T, allowedFields: readonly string[]) {
    this.check = Compile(schema);
    this.allowed = new Set(allowedFields);
  }

  get pending(): boolean { return this.draft !== null; }

  /** Called by Pi before its schema validator. Other shape errors retain its normal handling. */
  prepare(value: unknown): Static<T> {
    this.draft = null;
    this.fields = [];
    this.stats.remainingFields = [];
    const candidate = Value.Convert(this.schema, structuredClone(value));
    const errors = [...this.check.Errors(candidate)];
    if (!errors.length || errors.length > 128) return value as Static<T>;
    const fields: Field[] = [];
    for (const error of errors) {
      const path = error.instancePath.slice(1).split("/").map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
      if ((error.keyword !== "minLength" && error.keyword !== "maxLength")
        || !this.allowed.has(path.at(-1) ?? "") || typeof readPath(candidate, path) !== "string") return value as Static<T>;
      if (fields.some((field) => field.location === error.instancePath)) continue;
      fields.push({ path, location: error.instancePath, field_id: `f${fields.length + 1}`,
        rule: error.keyword, limit: Number(error.params.limit) });
    }
    this.draft = candidate;
    this.fields = fields;
    this.stats.remainingFields = fields.map(({ location, path, rule, limit }) => ({
      location, rule, limit, currentLength: Guard.GraphemeCount(readPath(candidate, path) as string),
    }));
    this.revision++;
    this.stats.drafts++;
    throw new Error(this.feedback());
  }

  feedback(): string {
    return "原提交已保存在本批草稿中，正确字段及对象全部保留。只修正下列文本，不重复提交整批结果。"
      + `请调用 ${TEXT_REPAIR_TOOL}，draft_id=${this.revision}，corrections仅填写field_id和新value。`
      + "长度单位是字符，含空格和标点，不是英文单词数。current_length为程序实际计数；按limit删去重复解释或补足必要文字。"
      + "不能删除对象、截断事实或改动其他字段；修正后程序会重新执行完整校验。\n"
      + JSON.stringify(this.fields.map(({ field_id, location, path, rule, limit }) => {
        const parent = readPath(this.draft, path.slice(0, -1));
        const object = parent && typeof parent === "object" ? parent as Record<string, unknown> : {};
        const identity = Object.fromEntries(["component_id", "group_id", "scope_id", "layer_group_id", "name", "title", "component_ids"]
          .filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
        const currentText = readPath(this.draft, path) as string;
        return { field_id, location, ...identity, current_text: currentText, current_length: Guard.GraphemeCount(currentText), rule, limit };
      }));
  }

  apply(update: Static<typeof TEXT_REPAIR_SCHEMA>): Static<T> {
    if (!this.pending || update.draft_id !== this.revision) throw new Error("修正草稿已失效；只使用最近工具反馈中的draft_id与field_id。");
    const byId = new Map(this.fields.map((field) => [field.field_id, field]));
    const seen = new Set<string>();
    for (const correction of update.corrections) {
      if (!byId.has(correction.field_id) || seen.has(correction.field_id)) throw new Error("只允许替换当前错误清单中的字段，每个field_id恰好提交一次。");
      seen.add(correction.field_id);
    }
    const candidate = structuredClone(this.draft);
    for (const correction of update.corrections) {
      const field = byId.get(correction.field_id)!;
      const parent = readPath(candidate, field.path.slice(0, -1)) as Record<string, unknown>;
      parent[field.path.at(-1)!] = correction.value;
    }
    this.stats.appliedFields += seen.size;
    const result = this.prepare(candidate);
    // A correction can only replace text, but still validate the entire original contract.
    if (!this.check.Check(result)) throw new Error("修正后完整Schema仍未通过；请重新调用submit_result提交完整结果。");
    return result;
  }
}
