# Third-party software in the forge's UI

The UI's own code is under the repository's licence. The built bundle also
contains the packages below, which keep their own. Each package's full licence
text is in its folder under `node_modules` (`LICENSE.md`, and `NOTICE.md` where
there is one); this file is the attribution those licences ask for. Add a
package here when the UI starts shipping it and it asks for one.

## @pierre/diffs and @pierre/trees

The branch page's diff and file tree (`src/features/review/diff/`).

- `@pierre/diffs` 1.7.1, with `@pierre/theme`, `@pierre/theming`,
  `@pierre/patches` and `@pierre/highlights`
- `@pierre/trees` 1.0.0

Copyright 2025 Pierre Computer Company. Licensed under the Apache License,
Version 2.0. You may obtain a copy of the licence at
<https://www.apache.org/licenses/LICENSE-2.0>. The packages are used as
published, without changes.

`@pierre/trees` carries this notice (its `NOTICE.md`):

> This project includes some code derived from
> [@headless-tree/core](https://github.com/lukasbach/headless-tree).

`@headless-tree/core` is under the MIT licence, Copyright (c) 2023 Lukas Bach:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
