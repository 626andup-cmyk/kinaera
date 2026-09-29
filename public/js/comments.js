/**
 * Comments on messages: select text to comment on it, in threads. Your
 * friend replies in the thread, or leaves a note you left for yourself.
 */

import { $, api, hideFormError, showFormError, state } from "./core.js";
import { formatTime } from "./format.js";
import { renderMessages, withBusyChannel } from "./messages.js";
import { refreshNotebook } from "./notebook.js";

// --------------------------------------------------------------- comments

/*
 * Comments are out-of-character notes on a message, or on part of one, in
 * threads. Select some text in a message and a Comment button appears; or
 * use a message's Comment action for the whole message. Commenting on your
 * friend's message gets a reply from them in the thread.
 */

/** The threads on one message. */
export function threadsOn(messageId) {
  return state.threads.filter((t) => t.messageId === messageId);
}

/**
 * Highlight each thread's quoted text inside a rendered message. Formatting
 * like *italics* is ignored when matching, since it isn't visible.
 */
export function highlightThreads(content, threads) {
  for (const thread of threads) {
    const quote = thread.quote.replace(/[*_]/g, "").trim();
    if (!quote) continue;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = "";
    while (walker.nextNode()) {
      nodes.push({ node: walker.currentNode, start: text.length });
      text += walker.currentNode.nodeValue;
    }
    const start = text.toLowerCase().indexOf(quote.toLowerCase());
    if (start < 0) continue;
    const end = start + quote.length;
    // Wrap the part of each text node that falls inside the quote.
    for (const { node, start: nodeStart } of nodes) {
      const nodeEnd = nodeStart + node.nodeValue.length;
      if (nodeEnd <= start || nodeStart >= end) continue;
      const range = document.createRange();
      range.setStart(node, Math.max(0, start - nodeStart));
      range.setEnd(node, Math.min(node.nodeValue.length, end - nodeStart));
      const mark = document.createElement("mark");
      mark.className = "comment-mark";
      if (thread.resolved) mark.classList.add("resolved");
      mark.dataset.thread = thread.id;
      mark.title = "Open the comments";
      range.surroundContents(mark);
    }
  }
}

/** Open a thread, or several (a picker switches between them). */
export function openThread(threadId) {
  const thread = state.threads.find((t) => t.id === threadId);
  if (!thread) return;
  state.thread = thread;
  renderThread();
  $("thread-dialog").showModal();
}

/** Start a new comment on a message, optionally on some quoted text. */
export function newComment(messageId, quote = "") {
  state.thread = { id: null, messageId, quote, resolved: false, comments: [] };
  renderThread();
  $("thread-dialog").showModal();
  $("thread-note").focus();
}

function renderThread() {
  const thread = state.thread;
  const form = $("thread-form");
  hideFormError(form);
  $("thread-title").textContent = thread.id ? "Comments" : "New comment";

  // More than one thread on this message: pick which.
  const siblings = thread.id ? threadsOn(thread.messageId) : [];
  const picker = $("thread-picker");
  picker.hidden = siblings.length < 2;
  picker.replaceChildren(
    ...siblings.map((t) => new Option(`${t.resolved ? "✓ " : ""}${t.quote ? `“${t.quote.slice(0, 40)}”` : "Whole message"}`, t.id)),
  );
  if (thread.id) picker.value = thread.id;

  const quote = $("thread-quote");
  quote.hidden = !thread.quote;
  quote.textContent = thread.quote;

  const friend = state.settings.friendName;
  $("thread-comments").replaceChildren(
    ...thread.comments.map((comment) => {
      const item = document.createElement("li");
      item.className = "thread-comment";
      item.dataset.author = comment.author;
      const who = document.createElement("span");
      who.className = "thread-comment-author";
      who.textContent = comment.author === "user" ? "You" : friend;
      const time = document.createElement("time");
      time.className = "message-time";
      time.textContent = formatTime(comment.createdAt);
      const note = document.createElement("p");
      note.className = "thread-comment-note";
      note.textContent = comment.note;
      item.append(who, time, note);
      if (comment.author === "user") {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "link-button";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => deleteComment(comment));
        item.append(remove);
      }
      return item;
    }),
  );

  const busy = state.busy.has(state.channelId);
  $("thread-status").hidden = !thread.replying;
  $("thread-status-text").textContent = `${friend} is replying…`;
  $("thread-send").textContent = thread.id ? "Reply" : "Comment";
  $("thread-send").disabled = Boolean(thread.replying);
  $("thread-resolve").hidden = !thread.id;
  $("thread-resolve").textContent = thread.resolved ? "Reopen" : "Resolve";
  $("thread-note").disabled = Boolean(thread.replying) || busy;
  $("thread-note").placeholder = busy
    ? `Wait for ${friend} to finish writing.`
    : "Out of character: the characters never see this.";
}

export async function sendComment(event) {
  event.preventDefault();
  const thread = state.thread;
  const note = $("thread-note").value.trim();
  if (!note) return;
  const channelId = state.channelId;
  // Your friend replies when it's their message, or they're in the thread.
  const message = state.messages.find((m) => m.id === thread.messageId);
  thread.replying = message?.author === "friend" || thread.comments.some((c) => c.author === "friend");
  thread.comments = [...thread.comments, { author: "user", note, createdAt: new Date().toISOString() }];
  $("thread-note").value = "";
  renderThread();

  const request = thread.id
    ? api("POST", `/api/comments/${encodeURIComponent(thread.id)}/replies`, { note })
    : api("POST", `/api/messages/${encodeURIComponent(thread.messageId)}/comments`, { note, quote: thread.quote });
  const work = async () => {
    try {
      const data = await request;
      acceptThread(data.thread);
      if (data.toolCalls?.length) {
        state.toolCalls.push(...data.toolCalls);
        refreshNotebook().catch(() => {});
      }
      if (data.error) showFormError($("thread-form"), `${state.settings.friendName} couldn't reply: ${data.error}`);
    } catch (error) {
      thread.replying = false;
      showFormError($("thread-form"), error.message);
    }
  };
  // While your friend replies, the channel is busy, like any turn.
  if (thread.replying) await withBusyChannel(channelId, work);
  else await work();
  // The channel is free again: unlock the reply box.
  if ($("thread-dialog").open) renderThread();
}

/** Put a thread from the server into state, and show it if it's open. */
function acceptThread(thread) {
  const index = state.threads.findIndex((t) => t.id === thread.id);
  if (index >= 0) state.threads[index] = thread;
  else state.threads.push(thread);
  if ($("thread-dialog").open && (state.thread.id === thread.id || !state.thread.id)) {
    state.thread = thread;
    renderThread();
  }
  renderMessages();
}

export async function resolveThread() {
  const thread = state.thread;
  try {
    const data = await api("POST", `/api/comments/${encodeURIComponent(thread.id)}/resolve`, { resolved: !thread.resolved });
    acceptThread(data.thread);
  } catch (error) {
    showFormError($("thread-form"), error.message);
  }
}

async function deleteComment(comment) {
  const first = comment.id === state.thread.id;
  if (!confirm(first ? "Delete this comment and its whole thread?" : "Delete this comment?")) return;
  try {
    await api("DELETE", `/api/comments/${encodeURIComponent(comment.id)}`, {});
    if (first) {
      state.threads = state.threads.filter((t) => t.id !== comment.id);
      $("thread-dialog").close();
      renderMessages();
    } else {
      state.thread.comments = state.thread.comments.filter((c) => c.id !== comment.id);
      acceptThread(state.thread);
    }
  } catch (error) {
    showFormError($("thread-form"), error.message);
  }
}

/**
 * When you select text inside a message, show a Comment button just below
 * the selection.
 */
export function updateCommentButton() {
  const button = $("comment-float");
  const selection = document.getSelection();
  const text = selection?.toString().trim() ?? "";
  // The selection's ends can be text nodes or elements.
  const contentOf = (node) => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(".message-content");
  const anchor = contentOf(selection?.anchorNode);
  const focus = contentOf(selection?.focusNode);
  if (!text || !anchor || anchor !== focus || text.length > 1000) {
    button.hidden = true;
    return;
  }
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  button.hidden = false;
  button.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 56)}px`;
  button.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 140))}px`;
  button.dataset.messageId = anchor.closest(".message").dataset.messageId;
  button.dataset.quote = text;
}
