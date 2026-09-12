package main

import "example/base"

type Child struct {
    base.Base
}

func Run() int {
    return base.Helper()
}
