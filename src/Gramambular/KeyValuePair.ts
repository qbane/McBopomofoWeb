/**
 * @license
 * Copyright (c) 2022 and onwards The McBopomofo Authors.
 * This code is released under the MIT license.
 * SPDX-License-Identifier: MIT
 */

export class KeyValuePair {
  key: string;
  value: string;

  constructor(key: string = "", value: string = "") {
    this.key = key;
    this.value = value;
  }

  toString(): string {
    return "(" + this.key + "," + this.value + ")";
  }

  equals(another: KeyValuePair): boolean {
    return this.key === another.key && this.value === another.value;
  }

  isGreaterThan(another: KeyValuePair): boolean {
    if (this.key > another.key) {
      return true;
    } else if (this.key === another.key) {
      return this.value > another.value;
    }
    return false;
  }

  isLessThan(another: KeyValuePair): boolean {
    if (this.key < another.key) {
      return true;
    } else if (this.key === another.key) {
      return this.value < another.value;
    }
    return false;
  }
}
