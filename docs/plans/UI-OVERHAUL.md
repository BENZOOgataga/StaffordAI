# UI overhaul

Rebuild Stafford's renderer to look and feel like Dokploy, using the same open-source
toolkit Dokploy uses, applied to Stafford's own features. Not a Dokploy clone: same
tools and taste, Stafford's own components for colleagues, projects, conversations, and
activity.

## Stack

shadcn/ui components on Radix primitives, Tailwind CSS, class-variance-authority for
variants, Lucide icons, on React. shadcn is copy-in code, so Stafford owns the source
under `src/renderer/components/ui/`.

Dokploy is Apache-2.0 (everything outside a `/proprietary` directory). I studied its
structure and patterns, the rail, the cards, the list rows, its shadcn theming, and
wrote Stafford's own components. No Dokploy screen code is copied.

## Re-platforming, stated plainly

The shipped renderer is vanilla TypeScript and direct DOM. shadcn needs React, so this
overhaul is a genuine vanilla-to-React re-platforming across phases, not a restyle. That
is accepted. To keep the shipped v0.1.0 app safe while it happens, React lives only in a
dev-only preview until a screen is migrated.

## Phase 1, done: the foundation

- React 19 plus the toolkit, pinned, behind a dev-only `preview.html` entry. The shipped
  `index.html` stays vanilla and imports none of it, so its bundle is byte-for-byte
  unchanged (same build hash before and after).
- Tailwind v4 with the shadcn token model in `src/renderer/styles/globals.css`: the dark
  register Dokploy ships with, semantic tokens (background, foreground, card, muted,
  border, primary, accent, destructive), plus status tokens for a colleague's state
  (working, idle, waiting, error) so the accent is a token edit, not a hardcoded rule.
  Retinting is proven: change a token and every primitive that reads it recolors.
- Core primitives in `src/renderer/components/ui/`: Button, Card, Badge, Tabs, Input,
  Textarea, StatusDot, ScrollArea, Separator, List and ListRow, Sidebar rail. Each is
  small, typed, accessible through Radix, and uses Lucide line icons.
- A dev-only showcase at `src/renderer/components/preview/preview.tsx`, rendered by the
  preview entry, shows every primitive and its variants. Open it in dev from the vite
  dev server at `/preview.html`. It never loads in the normal app flow.

## Structure

Feature-based, migrated into over later phases.

- `src/renderer/components/ui/` shared primitives (shadcn, Stafford owns the source).
- `src/renderer/lib/utils.ts` the `cn` class merger.
- `src/renderer/styles/globals.css` the theme.
- `src/renderer/components/preview/` the dev-only showcase.
- Feature folders for roster, conversation, transcript, and a home dashboard land as
  each screen is migrated.

## Next phases

2. Migrate the first screen onto the primitives, a Dokploy-style home dashboard or the
   roster, for Stafford's data. Mount React into that screen's window.
3. Migrate the remaining screens, then retire the vanilla renderer and the old inline
   styles once nothing reads them.
