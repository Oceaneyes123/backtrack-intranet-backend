const getMessageMutationError = (message, user) => {
  if (!message || message.deleted_at) {
    return { status: 404, error: "Message not found." };
  }

  if (!user?.id || user.google_sub === "anonymous") {
    return { status: 401, error: "Authentication required." };
  }

  if (message.sender_user_id !== user.id) {
    return { status: 403, error: "Forbidden." };
  }

  return null;
};

const requireMessageOwnership = (message, user, res) => {
  const failure = getMessageMutationError(message, user);
  if (!failure) return true;
  res.status(failure.status).json({ error: failure.error });
  return false;
};

export { getMessageMutationError, requireMessageOwnership };