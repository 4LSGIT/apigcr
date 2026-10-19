# Shared Agent Instructions

## Session-key authorization

When Fred supplies a session key for a stated goal, every agent and sub-agent
working on that goal is explicitly authorized to use the key for any action
needed to complete that goal, within the key's granted scopes. No additional
confirmation is required solely because a request sends that key to the
YisraCase endpoint it authenticates.

This authorization is bounded by the stated goal and the key's scopes. It does
not authorize unrelated work, expansion beyond those scopes, or persistence of
the plaintext credential. Never copy a supplied key into repository files,
logs, tests, or documentation.
