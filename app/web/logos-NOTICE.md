# Lab logos

The SVG files in `labs/` are the logos of AI labs, shown next to a model's name. They were downloaded on 2026-11-17 from
[models.dev](https://models.dev) (project `anomalyco/models.dev`, MIT licence), at `https://models.dev/logos/labs/{lab}.svg`.

The logos are trademarks of their owners, used only to identify the provider or lab of a model.

- The logo files are in `public/logos/labs/`. This notice is kept outside `public/` so that it is not served.
- A logo is shown only through `<img src="/logos/labs/<id>.svg">` (`src/ui/LabLogo.jsx`), never inlined into the page.
- `LAB_LOGOS` in `src/ui/LabLogo.jsx` lists the ids; `tests/lab-logo.test.jsx` keeps it and the files in step.
- Every file must pass `node scripts/check-logos.mjs` (one plain `<svg>`, under 20 kB, nothing active in it). A file that
  fails is rejected, not edited.
- Ids that models.dev has no logo for (it answers with a generic placeholder) are not included: `amazon`, `baidu`,
  `bytedance`, `microsoft`, `openrouter`, `qwen`, `stepfun`.

## Licence of the source (models.dev)

The logo files were taken from the models.dev project, which is released under the MIT licence:

```
MIT License

Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
