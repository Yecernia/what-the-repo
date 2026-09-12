import { Base, helper } from "./base";

export class Child extends Base {
  run(): number {
    return helper();
  }
}
