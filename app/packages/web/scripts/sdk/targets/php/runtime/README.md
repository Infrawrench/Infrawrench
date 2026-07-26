# PHP runtime sources

The hand-written half of the generated PHP SDK. Every file here is emitted
verbatim into `sdk/php/src/`, with the licence banner spliced in after the
opening `<?php` tag and a handful of `@@TOKEN@@` placeholders substituted — see
`RUNTIME_FILES` in `../index.ts`.

They carry a `.php.txt` suffix so nothing in this repository — `php -l` sweeps,
composer autoloaders, editor tooling — mistakes them for source belonging to the
web app. They are still valid PHP, so `php -l` works on them directly while
editing.

Each file starts with a `// --8<--` sentinel. Everything above it is a note to
whoever is editing the runtime; everything below it ships.
