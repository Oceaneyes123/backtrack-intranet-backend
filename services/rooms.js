import {
  getRoomById,
  getRoomByName,
  getOrCreateRoom,
  ensureMembership as ensureMembershipRepo,
  isMember as isMemberRepo,
  getRoomMembers,
  getRoomMembersForRooms,
  getDirectRoomOtherUser,
  listRoomsForUser as listRoomsForUserRows
} from "../repo/rooms.js";
import { getLastReadAt, getOtherLastReadAt, getUnreadCount, getRoomReadStatesForUser } from "../repo/reads.js";
import { getLastMessagesForRooms } from "../repo/messages.js";

const isPublicRoomName = (roomName) => {
  return String(roomName || "").trim().toLowerCase() === "general";
};

const getRoomOrCreatePublic = (roomName) => {
  const normalized = String(roomName || "").trim() || "general";
  const existing = getRoomByName(normalized);
  if (existing) {
    if (isPublicRoomName(normalized) && !existing.display_name) {
      return getOrCreateRoom(normalized, "General");
    }
    return existing;
  }
  const byId = getRoomById(normalized);
  if (byId) return byId;
  if (isPublicRoomName(normalized)) return getOrCreateRoom(normalized, "General");
  return null;
};

const ensureMembership = (roomId, userId) => {
  ensureMembershipRepo(roomId, userId);
};

const isMember = (roomId, userId) => {
  return isMemberRepo(roomId, userId);
};

const requireRoomAccess = (room, user, res) => {
  if (!room) {
    res.status(404).json({ error: "Room not found." });
    return false;
  }
  if (!user) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }

  if (isPublicRoomName(room.name)) {
    ensureMembership(room.id, user.id);
    return true;
  }

  if (!isMember(room.id, user.id)) {
    res.status(403).json({ error: "Forbidden." });
    return false;
  }

  return true;
};

const resolveRoomDisplayName = (room, directOther) => {
  const isDirect = Boolean(directOther);
  const type = isDirect ? "dm" : "group";
  let displayName = room?.display_name;
  if (isDirect) {
    displayName = directOther.display_name || directOther.email || "Direct Message";
  } else if (isPublicRoomName(room?.name)) {
    displayName = displayName || "General";
  } else if (!displayName) {
    displayName = "Group";
  }
  return { type, displayName };
};

const getRoomMeta = (roomId, userId) => {
  const lastReadAt = getLastReadAt(roomId, userId);
  const otherLastReadAt = getOtherLastReadAt(roomId, userId);
  const unreadCount = getUnreadCount(roomId, userId, lastReadAt);
  const members = getRoomMembers(roomId);
  return { lastReadAt, otherLastReadAt, unreadCount, members };
};

const listRoomsForUser = (user) => {
  if (!user) return [];
  const general = getOrCreateRoom("general", "General");
  ensureMembership(general.id, user.id);

  const rows = listRoomsForUserRows(user.id);
  const roomIds = rows.map((row) => row.id);
  const lastMessages = new Map(
    getLastMessagesForRooms(roomIds).map((row) => [row.room_id, row])
  );
  const readStates = new Map(
    getRoomReadStatesForUser(roomIds, user.id).map((row) => [row.roomId, row])
  );
  const membersByRoom = new Map();
  getRoomMembersForRooms(roomIds).forEach((row) => {
    if (!membersByRoom.has(row.roomId)) membersByRoom.set(row.roomId, []);
    membersByRoom.get(row.roomId).push({
      email: row.email,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl
    });
  });

  return rows.map((row) => {
    const directOther = row.user_a_id || row.user_b_id
      ? { display_name: row.other_display_name, email: row.other_email }
      : null;
    const { type, displayName } = resolveRoomDisplayName(
      { name: row.name, display_name: row.display_name },
      directOther
    );
    const last = lastMessages.get(row.id);
    const readState = readStates.get(row.id);
    const members = membersByRoom.get(row.id) || [];

    return {
      room: row.name,
      type,
      name: displayName,
      displayName,
      lastMessage: last?.body || "",
      lastMessageAt: last?.created_at || row.created_at || null,
      unread: readState?.unreadCount || 0,
      members,
      lastReadAt: readState?.lastReadAt || null,
      otherLastReadAt: readState?.otherLastReadAt || null
    };
  });
};

export {
  isPublicRoomName,
  getRoomOrCreatePublic,
  ensureMembership,
  isMember,
  requireRoomAccess,
  resolveRoomDisplayName,
  getRoomMeta,
  getRoomMembers,
  getDirectRoomOtherUser,
  listRoomsForUser
};
