# Lab logos

The SVG files in `labs/` are the logos of AI labs, shown next to a model's name. They were downloaded on 2026-11-17 from
[models.dev](https://models.dev) (project `anomalyco/models.dev`, MIT licence), at `https://models.dev/logos/labs/{lab}.svg`.

The logos are trademarks of their owners, used only to identify the provider or lab of a model.

- A logo is shown only through `<img src="/logos/labs/<id>.svg">` (`src/ui/LabLogo.jsx`), never inlined into the page.
- `LAB_LOGOS` in `src/ui/LabLogo.jsx` lists the ids; `tests/lab-logo.test.jsx` keeps it and the files in step.
- Every file must pass `node scripts/check-logos.mjs` (one plain `<svg>`, under 20 kB, nothing active in it). A file that
  fails is rejected, not edited.
- Ids that models.dev has no logo for (it answers with a generic placeholder) are not included: `amazon`, `baidu`,
  `bytedance`, `microsoft`, `openrouter`, `qwen`, `stepfun`.
