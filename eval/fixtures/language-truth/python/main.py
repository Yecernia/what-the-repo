from base import Base, helper


class Child(Base):
    def run(self) -> int:
        return helper()
