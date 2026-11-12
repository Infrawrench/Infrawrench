<?php
// `php -m` (bin/php), which phpix does not have.
foreach ([false => '[PHP Modules]', true => '[Zend Modules]'] as $zend => $title) {
    $names = get_loaded_extensions($zend);
    natcasesort($names);
    echo $title, "\n";
    foreach ($names as $name) {
        echo $name, "\n";
    }
    echo "\n";
}
