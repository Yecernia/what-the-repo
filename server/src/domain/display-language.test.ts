import assert from "node:assert/strict";
import test from "node:test";
import { createProject } from "./conversation.js";
import { inferDisplayLanguage, projectDisplayLanguage } from "./display-language.js";

test("explicit project language survives a conversation in another language; legacy projects still infer", () => {
  const project = createProject("guest:language", "https://github.com/example/repo", "Language", null);
  project.messages = [{ role: "user", content: "请解释一下这个仓库" }] as typeof project.messages;
  project.display_language = "en-US";
  assert.equal(projectDisplayLanguage(project), "en");
  project.display_language = "zh-CN";
  project.messages[0]!.content = "Explain this repository";
  assert.equal(projectDisplayLanguage(project), "zh-CN");
  delete project.display_language;
  project.messages[0]!.content = "请解释一下这个仓库";
  assert.equal(projectDisplayLanguage(project), "zh-CN");
});

test("reply language follows the latest request, explicit instructions and meaningful prose", () => {
  const message = (content: string) => ({role: "user" as const, content});
  assert.equal(inferDisplayLanguage([message("请解释仓库"), message("hello")], "zh-CN"), "en");
  assert.equal(inferDisplayLanguage([message("Explain the repo"), message("讲一下入口")], "en"), "zh-CN");
  assert.equal(inferDisplayLanguage([message("请用英文帮我制定研学路线")], "zh-CN"), "en");
  assert.equal(inferDisplayLanguage([message("Please reply in Chinese")], "en"), "zh-CN");
  assert.equal(inferDisplayLanguage([message("这些文档使用英文吗？")], "zh-CN"), "zh-CN");
  assert.equal(inferDisplayLanguage([message("```typescript\nconst label = 'English';\n``` https://example.com")], "zh-CN"), "zh-CN");
});
