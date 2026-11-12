<?php
// `php -l <file>...` (bin/php), which phpix does not have. This checks
// syntax with the parser; php-cli's -l also compiles, so errors only the
// compiler finds (a duplicate function, say) pass here.
$status = 0;
foreach (array_slice($argv, 1) as $file) {
    $code = @file_get_contents($file);
    if ($code === false) {
        echo "Could not open input file: $file\n";
        $status = 1;
        continue;
    }
    try {
        token_get_all($code, TOKEN_PARSE);
        echo "No syntax errors detected in $file\n";
    } catch (ParseError $e) {
        echo "PHP Parse error:  {$e->getMessage()} in $file on line {$e->getLine()}\n";
        echo "Errors parsing $file\n";
        $status = 255;
    }
}
exit($status);
