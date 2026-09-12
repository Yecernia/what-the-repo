mod base;

use base::{helper, BaseTrait};

struct Child;

impl BaseTrait for Child {
    fn ping(&self) -> i32 {
        1
    }
}

fn run() -> i32 {
    helper()
}
