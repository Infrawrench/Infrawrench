<?php
// Prepended to every script `php` runs (bin/php): back into the directory
// it was started from, which phpix left for the script's own.
(static function () {
    $cwd = getenv('PHP_CALLER_CWD');
    if (is_string($cwd) && $cwd !== '') {
        chdir($cwd);
    }
    putenv('PHP_CALLER_CWD');
    unset($_SERVER['PHP_CALLER_CWD'], $_ENV['PHP_CALLER_CWD']);
})();
