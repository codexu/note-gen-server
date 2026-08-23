# NoteGen Self-hosted Sync Protocol v1

Status: frozen for the first NoteGen client integration.

The runtime contract is the OpenAPI document served by `GET /openapi.json`. Route schemas must be changed before generated clients or this document. Protocol v1 does not preserve compatibility with the unpublished pre-v1 draft.

## Workspace model

- `account-data`: one idempotently-created, non-shareable personal workspace per account. It contains tags, marks, canvases, conversation metadata, independent messages, memories, portable settings, and their attachments.
- `library`: a note directory containing folders, Markdown notes, assets, and their Yjs updates and checkpoints. A local directory binds to exactly one library; the same library can bind to different local paths on different devices.

Libraries have an owner plus optional members. Roles (`viewer`, `editor`, `manager`) are templates over the fixed capability set; invitations and member updates may submit a capability subset. Owners always retain every capability. Account-data workspaces cannot be invited to or shared.

The server enforces the workspace/object boundary. `folder` and `note` objects are valid only in a library; `canvas`, `tag`, `mark`, `conversation`, `message`, `memory`, and `setting` objects are valid only in account-data. `asset` and CRDT support kinds may be used by either workspace type. A write that crosses this boundary is rejected with `workspace_object_kind_invalid`.

## Durable loop

Every sync write includes `expectedSyncEpoch`. A client runs:

```text
GET sync/session
→ fixed snapshot bootstrap when required
→ POST durable commands
→ GET ordered events
→ persist and apply inbox
→ POST ack
→ connect WebSocket for wake-up and presence
```

`commandId` is an immutable idempotency key. The same ID may only be retried with the same payload. Cursor advancement happens only after the inbox is durable and successfully applied. WebSocket messages never advance the cursor.

`GET /v1/workspaces/:id/sync/session` negotiates protocol v1 and returns cursor state, latest sequence, bootstrap requirement, limits, key versions, current permissions, sync epoch, and the WebSocket URL.

## Object and collaboration model

Object kinds are `folder`, `note`, `asset`, `canvas`, `tag`, `mark`, `conversation`, `message`, `memory`, `setting`, `yjs-update`, and `yjs-checkpoint`. The unpublished `record` kind is not part of v1.

Markdown uses a portable encrypted snapshot plus durable encrypted Yjs updates in a library workspace. Canvas state belongs to the account-data workspace, uses Yjs maps for nodes and edges, and periodically materializes ordinary Canvas JSON. `append-update` and `commit-checkpoint` are HTTP commands. The server commits the update and event transaction before publishing `workspace.changed`; it never accepts an update payload over WebSocket.

A checkpoint and its materialized object revision must both be acknowledged before clients discard covered local updates. Source mode, large-document mode, and external file changes use snapshot three-way merge and create a local conflict copy when no safe merge exists.

## WebSocket

The first frame is:

```json
{
  "type": "authenticate",
  "accessToken": "...",
  "workspaceIds": ["..."],
  "expectedSyncEpoch": "..."
}
```

After `authenticated`, clients may send `document.subscribe`, `document.unsubscribe`, `presence.update`, and `presence.clear`. Server messages include durable-change wake-ups, document sync requests, presence, membership changes, key changes, workspace state, and access revocation. Presence is ephemeral and is never written to the sync event log.

`presence.update` always carries the active document, selection anchor/head, and a `coordinateSpace` of `markdown`, `prosemirror`, or `canvas`. Receivers render text cursors only in the matching coordinate space. Older clients that omit the field are treated as `prosemirror` (or `canvas` when canvas presence is present). For Canvas, the message may additionally carry `canvas.nodes` with at most 100 `{ id, x, y }` positions. Drag positions are ephemeral; the drag-stop state must still be persisted through an encrypted durable Yjs command.

## Managed encryption v1

The first release uses managed workspace keys. Content remains encrypted in object and Blob storage; the server retains a managed envelope so a newly authorized device can recover the key. Payload encryption is XChaCha20-Poly1305 with a random 24-byte nonce. Device key interfaces use X25519 and HKDF-SHA256, and Argon2id APIs are reserved for later user-controlled E2EE.

Tokens, API keys, device private keys, local paths, sync profiles, caches, thumbnails, embeddings, vector indexes, activity statistics, and hardware choices are never synchronized.

## Bootstrap and conflicts

The first bootstrap request omits `bootstrapId`; subsequent pages repeat the returned ID and `afterObjectId`. All pages belong to one `snapshotSequence`. The client stages and applies the snapshot, ACKs the snapshot sequence, then pulls later events. It never offers an entire-library overwrite.

Same-path divergent content produces a conflict copy. A viewer's local modification becomes a permission conflict and can be exported or moved to a personal library. Membership removal stops the runtime immediately, deletes that workspace's locally stored credentials, and leaves downloaded files as a local read-only/exportable copy.

## Transport security

HTTPS never downgrades automatically. NoteGen may connect to a non-local HTTP instance only after displaying a clear warning, and it keeps the connection marked insecure. Browser device authorization is the default login; password and optional TOTP are fallback methods.
