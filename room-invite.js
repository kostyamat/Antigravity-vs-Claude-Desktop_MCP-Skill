'use strict';
// An invitation into a room is one act: the window becomes a member and is told,
// in the same breath, how to join. Before this, the board only added the member;
// the owner then copied the room id, opened the window's chat, pasted it, and
// waited while the agent worked out what to do with it.
//
// The text is shared by every way a window gets invited — the owner on the board,
// an agent with invite_to_room — so there is one wording to keep right. The calls
// come first: the Antigravity waker passes on only the first 300 characters.
// It names the window, which also keeps two invitations from looking like one
// duplicated post to the board's duplicate guard.

function inviteText(room, { name = '', card = '', why = '' } = {}) {
  const id = room.id;
  const who = name || card;
  return `Room invitation${who ? ' for ' + who : ''}: "${room.name}", room id ${id}.\n` +
    `Join now: get_messages({room: "${id}", only: "all"}), then list_docs({room: "${id}"}). ` +
    `Answer in the room: post_message with room: "${id}".` +
    (String(why).trim() ? `\n\n${String(why).trim()}` : '');
}

module.exports = { inviteText };
