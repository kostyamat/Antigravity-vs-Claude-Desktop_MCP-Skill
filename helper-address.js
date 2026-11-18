'use strict';
// Whom a helper's post is for, when the helper did not say.
//
// A helper (an Antigravity window paired with a Claude lead) answers its lead and is
// expected to address it. It regularly does not: it names its own room, writes to "all",
// leaves out replyTo — and the lead's watchman, which wakes a window only for mail
// addressed to it, never fires. The lead sat waiting while the helper had answered its
// question within ten seconds (owner, 18.11: qf_sysapps_repair, #6227 answered by #6228
// "to: all", no replyTo; "Antigravity does this regularly").
//
// So a helper's post in its pair room that names nobody goes to its lead, and when the
// lead's last question to it is still unanswered, it becomes the reply to that question.
// A post that names an addressee, replies to something, or goes to another room or the
// Square is left as the helper wrote it.

// boss: { lead, room } of this helper (router.leadOf); mine: the helper's window;
// toSession / replyTo: what the helper gave; namedRoom: the room it named ('' for none);
// roomName: the pair room's name; recent: the pair room's latest messages, oldest first.
function toLead({ boss, mine, toSession, replyTo, namedRoom, square, roomName, recent, same }) {
  if (!boss || !boss.lead || square === true) return null;
  if (String(toSession || '').trim() && String(toSession).trim() !== 'all') return null;
  if (replyTo) return null;
  const named = String(namedRoom || '').trim();
  if (named && named !== boss.room && named !== String(roomName || '')) return null;
  const eq = same || ((a, b) => a === b);
  let question = null;
  for (const m of recent || []) {
    if (eq(m.fromSession, mine)) question = null;                       // the helper spoke after it
    else if (eq(m.fromSession, boss.lead) && m.status === 'question' &&
             (!m.toSession || m.toSession === 'all' || eq(m.toSession, mine))) question = m;
  }
  return { toSession: boss.lead, replyTo: question ? question.id : null };
}

module.exports = { toLead };
