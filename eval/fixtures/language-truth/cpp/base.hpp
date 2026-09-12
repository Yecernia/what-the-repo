#pragma once

class Base {
public:
    int ping() const { return 1; }
};

inline int helper() {
    return 2;
}
