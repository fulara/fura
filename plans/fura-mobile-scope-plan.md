# Fura mobile UI scope

Mobile is a lightweight session client, not a port of the desktop workspace.

In scope for the mobile shell:
- connect with the same cookie-backed browser auth as desktop
- list/open existing sessions
- create a normal session from a working directory
- send prompts and render transcript/tool/todo projections
- later: add a mobile diff tab/view after the core mobile flow is stable

Out of scope for mobile unless product direction changes:
- Ask Fura controller UI
- Dockview workspace/panels/popouts
- model picker
- desktop diff workspace controls in the initial mobile shell
- git worktree creation flow in the initial mobile create form

Worktree support may be added later as a small extension to mobile session creation; it should stay mobile-native and not import the desktop cwd/worktree modal.
