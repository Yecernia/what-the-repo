#include "base.hpp"

class Child : public Base {
public:
    int run() {
        return helper();
    }
};
