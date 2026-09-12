import assert from "node:assert/strict";
import test from "node:test";
import { createProject, emptyProfile } from "../domain/conversation.js";
import { isExplicitAdvanceRequest, primarySystemPrompt } from "./prompts.js";

test("explicit advance intent is recognized only from the current user message", () => {
  assert.equal(isExplicitAdvanceRequest("直接进入下一步"), true);
  assert.equal(isExplicitAdvanceRequest("我想跳过这一步的理解检查"), true);
  assert.equal(isExplicitAdvanceRequest("请解释一下当前步骤"), false);
  assert.equal(isExplicitAdvanceRequest("不能跳过检查"), false);
});

test("primary dynamic prompt binds the user's explicit skip choice", () => {
  const project = createProject("guest:prompt", "https://github.com/example/prompt", "prompt", "free:test");
  const prompt = primarySystemPrompt({
    project,
    profile: emptyProfile(),
    selection: null,
    currentUserMessage: "直接进入下一步",
  });
  assert.match(prompt, /程序已识别当前用户明确要求进入下一步/);
  assert.match(prompt, /propose_learning_action/);
  assert.match(prompt, /skipped_steps/);
});

test("primary prompt fixes the user-visible file citation format", () => {
  const project = createProject("guest:prompt-files", "https://github.com/example/prompt-files", "prompt-files", "free:test");
  const prompt = primarySystemPrompt({
    project,
    profile: emptyProfile(),
    selection: null,
  });
  assert.match(prompt, /完整仓库相对路径/);
  assert.match(prompt, /`src\/path\/file\.ts:12-18`/);
  assert.match(prompt, /也可在明确说明目录后列出文件名/);
  assert.match(prompt, /Field\.eval/);
});

test("chat language has a UI fallback without locking replies to the project language", () => {
  const project = createProject("guest:language", "https://github.com/example/repo", "中文项目", null, "zh-CN");
  const prompt = primarySystemPrompt({project,profile:emptyProfile(),selection:null,currentUserMessage:"hello",displayLanguage:"en"});
  assert.match(prompt, /界面默认语言：English/);
  assert.match(prompt, /用户明确指定/);
  assert.match(prompt, /hello 就用英文/);
});
