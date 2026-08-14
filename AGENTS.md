## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)

## Design Constitution

Rec-Ord is a quiet, gesture-led personal tool. Treat this interaction and visual language as a product constraint, not a theme that can be replaced feature by feature.

- The current record and value are always the visual protagonists. New functionality must not compete with them.
- Add no permanent toolbars, sidebars, floating buttons, menu rows, or navigation chrome.
- Use progressive disclosure: reveal actions only inside the context where they are needed.
- Gestures own frequent navigation. Visible controls are reserved for contextual, transactional actions such as save, create, restore, or confirmed deletion.
- A feature does not automatically deserve a new button. Reuse existing surfaces or one consolidated temporary utility surface.
- Preserve the black and off-black surfaces. Yellow is a scarce signal, not decoration. Do not introduce blue or cyan UI tones.
- Preserve Archivo Narrow for dominant display type and IBM Plex Sans for supporting interface text.
- Negative space is intentional. Do not fill available room merely because it exists.
- Motion must communicate continuity, direction, hierarchy, or feedback. Never add decorative movement or presentation-style whole-screen transitions.
- New functionality that cannot fit this grammar must be redesigned or rejected.

Before approving any visual feature, confirm that the primary focus view gains no persistent control and that the feature disappears completely when its context is closed.
