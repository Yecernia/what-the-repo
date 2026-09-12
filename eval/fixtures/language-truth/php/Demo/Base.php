<?php

namespace Demo;

class Base
{
    public function ping(): int
    {
        return 1;
    }
}

function helper(): int
{
    return 2;
}
