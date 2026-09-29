/**
 * Texting in OOC: your bubbles are sent as you type them, your friend
 * answers once you pause, and their reply arrives one bubble at a time with
 * "typing…" in between.
 */

import { autoGrow, renderComposer } from "./composer.js";
import { api, channelPath, els, showError, state } from "./core.js";
import { friendTurn, renderMessages, scrollToBottom, sendMessage } from "./messages.js";

// ------------------------------------------------------------- texting

/*
 * Texting in OOC (src/texting.ts), like Kitsikai: each thing you send is
 * its own bubble, and your friend waits until you pause (replyDelayMs,
 * longer while you're still typing) before answering all of them in one
 * turn. Their answer comes as a burst of texts, shown one at a time with
 * "typing…" between them: base + characters × per-character, so a long
 * text takes longer. Double-tap "typing…" to skip the wait. History and
 * your own messages always show at once.
 */

/** Send one bubble without asking for a reply yet. */
export async function sendText(channelId, content) {
  const attach = [...(state.attachments.get(channelId) ?? [])];
  state.attachments.delete(channelId);
  const placeholder = {
    id: "pending",
    channelId,
    kind: "post",
    mode: null,
    author: "user",
    content,
    characters: [],
    attachments: attach,
    reactions: [],
    createdAt: new Date().toISOString(),
  };
  state.messages.push(placeholder);
  els.input.value = "";
  state.drafts.delete(channelId);
  autoGrow();
  renderMessages();
  scrollToBottom();
  try {
    const data = await api("POST", channelPath("messages", channelId), { content, attach, reply: false });
    const index = state.messages.indexOf(placeholder);
    if (index >= 0) state.messages.splice(index, 1, ...data.userMessages);
    renderMessages();
    scheduleReply(channelId);
  } catch (error) {
    state.messages = state.messages.filter((m) => m !== placeholder);
    renderMessages();
    if (state.channelId === channelId && els.input.value === "") {
      els.input.value = content;
      autoGrow();
    }
    showError(error.message, sendMessage);
  }
}

/** Ask for your friend's answer once you've paused. */
function scheduleReply(channelId) {
  clearTimeout(state.replyTimer);
  state.replyChannel = channelId;
  state.replyTimer = setTimeout(() => {
    state.replyTimer = 0;
    if (state.channelId === channelId) friendTurn();
  }, state.settings.replyDelayMs);
}

// Still typing another bubble: keep waiting.
els.input.addEventListener("input", () => {
  if (state.replyTimer && els.input.value.trim() !== "") scheduleReply(state.replyChannel);
});

/** How long a text takes to "type". */
function typingDelay(text) {
  return state.settings.typingBaseMs + text.length * state.settings.typingPerCharMs;
}

/** Show the rest of a burst one text at a time. */
export function revealLater(channelId, queue) {
  stopReveal();
  const reveal = { channelId, queue: [...queue], timer: 0 };
  state.reveal = reveal;
  renderComposer();
  const next = () => {
    if (state.reveal !== reveal) return;
    if (reveal.queue.length === 0) return finishReveal();
    reveal.timer = setTimeout(() => {
      const message = reveal.queue.shift();
      if (!state.messages.some((m) => m.id === message.id)) state.messages.push(message);
      renderMessages();
      scrollToBottom();
      next();
    }, typingDelay(reveal.queue[0].content));
  };
  next();
}

/** Show whatever's left of a burst straight away (double-tap "typing…", or you send something). */
export function finishReveal() {
  const reveal = state.reveal;
  if (!reveal) return;
  clearTimeout(reveal.timer);
  state.reveal = null;
  if (state.channelId === reveal.channelId) {
    for (const message of reveal.queue) if (!state.messages.some((m) => m.id === message.id)) state.messages.push(message);
    renderMessages();
    scrollToBottom();
  }
  renderComposer();
}

/** Forget a burst (you left the channel: it loads in full when you come back). */
export function stopReveal() {
  if (!state.reveal) return;
  clearTimeout(state.reveal.timer);
  state.reveal = null;
}

els.status.addEventListener("dblclick", finishReveal);
