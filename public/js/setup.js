/**
 * After a fresh start (`bun run fresh`, src/fresh.ts): before anything
 * else, you make your new friend. Their name, face and colour, who they
 * are and their tastes, written by you or rolled with Surprise me. Once
 * they're made (POST /api/setup), their first turn is an orientation.
 */

import { $, api, hideFormError, showFormError, state } from "./core.js";
import { paintAvatar } from "./friend-page.js";

/** Show the setup, if a fresh start asked for it. It can't be dismissed. */
export function maybeOpenSetup() {
  if (!state.setup) return false;
  const dialog = $("setup-dialog");
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  preview();
  dialog.showModal();
  return true;
}

function look() {
  const form = $("setup-form").elements;
  return {
    name: form.name.value.trim() || "?",
    avatar: form.avatar.value.trim(),
    color: form.themeColor.checked ? -1 : Number(form.color.value),
  };
}

function preview() {
  const form = $("setup-form").elements;
  form.color.disabled = form.themeColor.checked;
  paintAvatar($("setup-avatar-preview"), look());
}

async function surprise() {
  const button = $("setup-surprise");
  const result = $("setup-surprise-result");
  button.disabled = true;
  result.textContent = "Rolling…";
  try {
    const { name, prompt, tastes, seeds } = await api("POST", "/api/friend/random", {});
    const form = $("setup-form").elements;
    form.name.value = name;
    form.prompt.value = prompt;
    form.tastes.value = tastes ?? "";
    preview();
    result.textContent = `Meet ${name} (${seeds}). Change anything, roll again, or meet them.`;
  } catch (error) {
    result.textContent = `✗ ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function create(event) {
  event.preventDefault();
  const form = $("setup-form").elements;
  hideFormError($("setup-form"));
  const button = $("setup-create");
  button.disabled = true;
  try {
    const { name, avatar, color } = look();
    await api("POST", "/api/setup", { name, avatar, color, prompt: form.prompt.value, tastes: form.tastes.value });
    location.reload();
  } catch (error) {
    showFormError($("setup-form"), error.message);
    button.disabled = false;
  }
}

$("setup-form").addEventListener("submit", create);
$("setup-form").addEventListener("input", preview);
$("setup-surprise").addEventListener("click", surprise);
