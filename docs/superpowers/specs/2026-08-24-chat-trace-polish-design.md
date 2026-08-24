# Deep Search Chat and Trace Polish Design

## Goal

Refine the existing dark chat and Trace interfaces into a restrained, premium workspace with smoother lines and clearer interaction feedback. Preserve all backend APIs, WebSocket behavior, Agent execution, RAGFlow integration, MySQL access, model configuration, Trace topology, and diagnostic capabilities.

## Direction

The visual direction is restrained rather than playful. Interactive controls use 10-12px radii, while content panels and repeated diagnostic items stay at 6-8px to avoid excessive card styling. Borders become lower-contrast and more consistent, shadows stay subtle, and the existing charcoal, teal, amber, and red palette continues to communicate hierarchy and state.

The interface should feel closer to a focused desktop research tool than a marketing page. It will not add decorative gradients, oversized headings, floating sections, or unrelated illustration.

## Shared Visual System

- Keep the near-black canvas and distinct charcoal sidebar, workspace, surface, and raised-surface layers.
- Preserve teal as the primary action and active-state color, amber for transitional states, red for failures, and green for completion.
- Use a shared radius scale: 6px for compact data surfaces, 8px for panels and graph nodes, 10px for navigation and secondary controls, and 12px for the chat composer and primary actions.
- Use one-pixel translucent borders with stronger borders only for focus, selection, and drag-over states.
- Use 140-200ms transitions for hover, focus, drawer, and navigation feedback. Respect `prefers-reduced-motion`.
- Keep existing system font stacks so the interface remains local, fast, and reliable on the target Windows environment.

## Chat Page

### Layout and hierarchy

- Retain the sidebar, top bar, message stream, and anchored composer architecture.
- Improve sidebar spacing and active-session treatment without increasing information density.
- Keep assistant answers largely unframed for readability; only user messages use a compact bubble.
- Increase consistency among the brand mark, icon buttons, trace action, file chips, status indicator, and composer.

### Composer

- Give the composer a 12px radius, softer border, clearer focus ring, and restrained elevation.
- Keep file attachment, drag and drop, status text, textarea growth, and submission behavior.
- Change keyboard behavior to `Enter` for submit and `Shift+Enter` for a newline, matching common chat applications. Composition events must not accidentally submit IME text.
- Show a clear busy state on the send control while a run is uploading, starting, restoring, or running.

### Conversation scrolling

- Continue following new events while the reader is already near the bottom.
- Stop forcing the message stream to the bottom when the reader has intentionally scrolled upward.
- Show a compact "back to latest" icon button when new content is below the current viewport.
- Return to the latest content when the user submits a new question or activates that control.

### Feedback

- Preserve current connection labels, notices, file chips, progress roles, generated files, and session history.
- Improve hover, pressed, disabled, focus-visible, upload drag-over, and running states without changing data flow.

## Trace Page

### Page structure

- Preserve the existing vertical diagnostic layout, task controls, six metrics, five role summaries, eight graph nodes, eleven graph edges, inspector drawer, event filters, final report, generated files, and raw data.
- Refine spacing and section separators so the long page scans more clearly without wrapping sections in additional cards.
- Keep the current vertical scrolling behavior and responsive navigation.

### Graph

- Preserve node identity, topology, status mapping, zoom, fit, and inspector actions.
- Render connections as smooth curves with rounded line caps and clearer active-state contrast. This is a geometry-only visual change and must not change edge count or meaning.
- Refine node focus, hover, selected, running, completed, failed, and unknown states using the shared radius and color system.

### Controls and records

- Harmonize task controls, upload zone, role buttons, graph controls, tabs, filters, record rows, and drawer controls.
- Improve selected and hover feedback while preserving every existing control and label required by the Trace scripts.
- Keep the inspector keyboard and focus behavior intact.

## Accessibility and Responsive Behavior

- Maintain visible keyboard focus for every interactive control.
- Preserve semantic labels, live regions, dialog attributes, disabled states, and touch targets.
- Ensure desktop, tablet, and mobile layouts have no overlapping controls or clipped text.
- Keep reduced-motion support and avoid viewport-based font scaling.
- Validate long Chinese text, long IDs, filenames, and status labels with wrapping or truncation appropriate to each surface.

## Technical Boundaries

Allowed implementation scope:

- `web/index.html`
- `web/styles.css`
- `web/chat.js`
- `web/trace.html`
- `web/trace.css`
- `web/app.js` or `web/visualizer.js` only where required for visual graph geometry or existing control feedback
- Focused frontend tests

Out of scope:

- FastAPI routes and response contracts
- WebSocket protocol and event handling contracts
- Agent roles, graph topology, or execution logic
- RAGFlow, MySQL, LLM, prompt, and environment configuration
- New external frontend runtime dependencies

## Error Handling

Existing notices and task statuses remain the source of truth. Visual changes may improve how failures, disconnections, disabled actions, and restore states appear, but must not reinterpret or suppress errors. Scroll and keyboard enhancements must degrade safely if optional DOM elements are unavailable.

## Verification

- Add or update focused tests for keyboard submission, IME safety, back-to-latest behavior, required DOM hooks, and preserved Trace topology.
- Run the existing Node frontend suites and focused Python web/Trace tests.
- Run the full Python suite and report any pre-existing integration failure separately.
- Reload the local app after changes and inspect chat and Trace at desktop and mobile widths when browser access is available.
- Confirm `/`, `/trace`, favicon, and static assets return HTTP 200.

## Acceptance Criteria

1. Chat and Trace use the restrained 10-12px rounded control language without excessive pill or card styling.
2. All existing backend operations and diagnostic capabilities remain available.
3. Enter submits, Shift+Enter inserts a newline, and IME composition does not submit prematurely.
4. Reading older chat content is not interrupted by incoming events, and returning to the latest content is a single action.
5. The Trace graph preserves all existing nodes and edges while using smoother connection geometry.
6. Desktop and mobile layouts remain usable, keyboard-accessible, and free of overlapping content.
