package base

type Base struct{}

func (Base) Ping() int {
    return 1
}

func Helper() int {
    return 2
}
