/**
 * @license
 * Copyright (c) 2022 and onwards The McBopomofo Authors.
 * This code is released under the MIT license.
 * SPDX-License-Identifier: MIT
 */

import {
  LanguageModel,
  BlockReadingBuilder,
  NodeAnchor,
  Walker,
  kSelectedCandidateScore,
} from "../Gramambular";
import { BopomofoKeyboardLayout, BopomofoReadingBuffer } from "../Mandarin";
import { UserOverrideModel } from "./UserOverrideModel";
import {
  ChoosingCandidate,
  Committing,
  Empty,
  EmptyIgnoringPrevious,
  InputState,
  Inputting,
  Marking,
  NotEmpty,
} from "./InputState";
import { Key, KeyName } from "./Key";
import { LocalizedStrings } from "./LocalizedStrings";
import { WebLanguageModel } from "./WebLanguageModel";
import * as _ from "lodash";

export class ComposedString {
  head: string = "";
  tail: string = "";
  tooltip: string = "";

  constructor(head: string, tail: string, tooltip: string) {
    this.head = head;
    this.tail = tail;
    this.tooltip = tooltip;
  }
}

const kPunctuationListKey = "`"; // Hit the key to bring up the list.
const kPunctuationListUnigramKey = "_punctuation_list";
const kPunctuationKeyPrefix = "_punctuation_";
const kCtrlPunctuationKeyPrefix = "_ctrl_punctuation_";
const kLetterPrefix = "_letter_";

const kMinValidMarkingReadingCount = 2;
const kMaxValidMarkingReadingCount = 6;
const kUserOverrideModelCapacity = 500;
const kObservedOverrideHalfLife = 5400.0; // 1.5 hr.

const kComposingBufferSize: number = 20;
const kMaxComposingBufferSize: number = 100;
const kMinComposingBufferSize: number = 4;
const kMaxComposingBufferNeedsToWalkSize: number = 10;
// Unigram whose score is below this shouldn't be put into user override model.
const kNoOverrideThreshold: number = -8.0;
const kEpsilon = 0.000001;
const kJoinSeparator = "-";

function GetKeyboardLayoutName(layout: BopomofoKeyboardLayout): string {
  if (layout === BopomofoKeyboardLayout.ETenLayout) {
    return "ETen";
  } else if (layout === BopomofoKeyboardLayout.HsuLayout) {
    return "Hsu";
  } else if (layout === BopomofoKeyboardLayout.ETen26Layout) {
    return "ETen26";
  } else if (layout === BopomofoKeyboardLayout.HanyuPinyinLayout) {
    return "HanyuPinyin";
  } else if (layout === BopomofoKeyboardLayout.IBMLayout) {
    return "IBM";
  }
  return "Standard";
}

function FindHighestScore(nodeAnchors: NodeAnchor[], epsilon: number): number {
  let highestScore = 0.0;
  for (let anchor of nodeAnchors) {
    if (anchor.node === undefined) {
      continue;
    }
    let score = anchor.node!.highestUnigramScore;
    if (score > highestScore) {
      highestScore = score;
    }
  }
  return highestScore + epsilon;
}

export class KeyHandler {
  private localizedStrings_: LocalizedStrings = new LocalizedStrings();
  public get languageCode(): string {
    return this.localizedStrings_.languageCode;
  }
  public set languageCode(value: string) {
    this.localizedStrings_.languageCode = value;
  }

  private selectPhraseAfterCursorAsCandidate_: boolean = false;
  public get selectPhraseAfterCursorAsCandidate(): boolean {
    return this.selectPhraseAfterCursorAsCandidate_;
  }
  public set selectPhraseAfterCursorAsCandidate(value: boolean) {
    this.selectPhraseAfterCursorAsCandidate_ = value;
  }

  private moveCursorAfterSelection_: boolean = false;
  public get moveCursorAfterSelection(): boolean {
    return this.moveCursorAfterSelection_;
  }
  public set moveCursorAfterSelection(value: boolean) {
    this.moveCursorAfterSelection_ = value;
  }

  private putLowercaseLettersToComposingBuffer_: boolean = false;
  public get putLowercaseLettersToComposingBuffer(): boolean {
    return this.putLowercaseLettersToComposingBuffer_;
  }
  public set putLowercaseLettersToComposingBuffer(value: boolean) {
    this.putLowercaseLettersToComposingBuffer_ = value;
  }

  private escKeyClearsEntireComposingBuffer_: boolean = false;
  public get escKeyClearsEntireComposingBuffer(): boolean {
    return this.escKeyClearsEntireComposingBuffer_;
  }
  public set escKeyClearsEntireComposingBuffer(value: boolean) {
    this.escKeyClearsEntireComposingBuffer_ = value;
  }

  public get keyboardLayout(): BopomofoKeyboardLayout {
    return this.reading_.keyboardLayout;
  }
  public set keyboardLayout(value: BopomofoKeyboardLayout) {
    this.reading_.keyboardLayout = value;
  }

  private composingBufferSize_: number = kComposingBufferSize;
  public get composingBufferSize(): number {
    return this.composingBufferSize_;
  }
  public set composingBufferSize(value: number) {
    if (value > kMaxComposingBufferSize) {
      value = kMaxComposingBufferSize;
    }
    if (value < kMinComposingBufferSize) {
      value = kMinComposingBufferSize;
    }
    this.composingBufferSize_ = value;
  }

  private traditionalMode_ = false;
  public get traditionalMode(): boolean {
    return this.traditionalMode_;
  }
  public set traditionalMode(flag: boolean) {
    this.traditionalMode_ = flag;
  }

  private languageModel_: LanguageModel;
  private reading_: BopomofoReadingBuffer;
  private builder_: BlockReadingBuilder;
  private walkedNodes_: NodeAnchor[] = [];
  private userOverrideModel_: UserOverrideModel = new UserOverrideModel(
    kUserOverrideModelCapacity,
    kObservedOverrideHalfLife
  );

  constructor(languageModel: LanguageModel) {
    this.languageModel_ = languageModel;
    this.reading_ = new BopomofoReadingBuffer(
      BopomofoKeyboardLayout.StandardLayout
    );
    this.builder_ = new BlockReadingBuilder(this.languageModel_);
    this.builder_.joinSeparator = kJoinSeparator;
  }

  handle(
    key: Key,
    state: InputState,
    stateCallback: (state: InputState) => void,
    errorCallback: () => void
  ): boolean {
    // From Key's definition, if shiftPressed is true, it can't be a simple key
    // that can be represented by ASCII.
    let simpleAscii = key.ascii;
    if (
      simpleAscii === "Shift" ||
      simpleAscii === "Meta" ||
      simpleAscii === "Alt"
    ) {
      return false;
    }
    // See if it's valid BPMF reading.
    let keyConsumedByReading = false;
    if (this.reading_.isValidKey(simpleAscii)) {
      this.reading_.combineKey(simpleAscii);
      keyConsumedByReading = true;
      // If asciiChar does not lead to a tone marker, we are done. Tone marker
      // would lead to composing of the reading, which is handled after this.
      if (!this.reading_.hasToneMarker) {
        stateCallback(this.buildInputtingState());
        return true;
      }
    }

    // Compose the reading if either there's a tone marker, or if the reading is
    // not empty, and space is pressed.
    let shouldComposeReading =
      (this.reading_.hasToneMarker && !this.reading_.hasToneMarkerOnly) ||
      (!this.reading_.isEmpty && key.name === KeyName.SPACE);

    if (shouldComposeReading) {
      let syllable = this.reading_.syllable.composedString;
      this.reading_.clear();

      if (!this.languageModel_.hasUnigramsForKey(syllable)) {
        errorCallback();
        if (!this.builder_.length) {
          stateCallback(new EmptyIgnoringPrevious());
        } else {
          stateCallback(this.buildInputtingState());
        }
        return true;
      }

      this.builder_.insertReadingAtCursor(syllable);
      let evictedText = this.popEvictedTextAndWalk();

      if (!this.traditionalMode_) {
        let overrideValue = this.userOverrideModel_?.suggest(
          this.walkedNodes_,
          this.builder_.cursorIndex,
          new Date().getTime()
        );
        if (overrideValue != null && overrideValue?.length != 0) {
          let cursorIndex = this.actualCandidateCursorIndex;
          let nodes = this.builder_.grid.nodesCrossingOrEndingAt(cursorIndex);
          let highestScore = FindHighestScore(nodes, kEpsilon);
          this.builder_.grid.overrideNodeScoreForSelectedCandidate(
            cursorIndex,
            overrideValue,
            highestScore
          );
        }
      }

      this.fixNodesIfRequired();

      let inputtingState = this.buildInputtingState();
      inputtingState.evictedText = evictedText;
      stateCallback(inputtingState);

      if (this.traditionalMode_) {
        let choosingCandidates =
          this.buildChoosingCandidateState(inputtingState);
        this.reset();
        if (choosingCandidates.candidates.length === 1) {
          let text = choosingCandidates.candidates[0];
          let committing = new Committing(text);
          stateCallback(committing);
          stateCallback(new Empty());
        } else {
          stateCallback(choosingCandidates);
        }
      }

      return true;
    }

    // The only possibility for this to be true is that the Bopomofo reading
    // already has a tone marker but the last key is *not* a tone marker key. An
    // example is the sequence "6u" with the Standard layout, which produces "ㄧˊ"
    // but does not compose. Only sequences such as "u6", "6u6", "6u3", or "6u "
    // would compose.
    if (keyConsumedByReading) {
      stateCallback(this.buildInputtingState());
      return true;
    }

    // Shift + Space.
    if (key.name === KeyName.SPACE && key.shiftPressed) {
      if (this.putLowercaseLettersToComposingBuffer_) {
        this.builder_.insertReadingAtCursor(" ");
        let evictedText = this.popEvictedTextAndWalk();
        let inputtingState = this.buildInputtingState();
        inputtingState.evictedText = evictedText;
        stateCallback(inputtingState);
      } else {
        if (this.builder_.length) {
          let inputtingState = this.buildInputtingState();
          // Steal the composingBuffer built by the inputting state.
          let committingState = new Committing(inputtingState.composingBuffer);
          stateCallback(committingState);
        }
        let committingState = new Committing(" ");
        stateCallback(committingState);
        this.reset();
      }
      return true;
    }

    // Space hit: see if we should enter the candidate choosing state.
    let maybeNotEmptyState = state as NotEmpty;

    if (
      (key.name === KeyName.SPACE || key.name === KeyName.DOWN) &&
      maybeNotEmptyState instanceof NotEmpty &&
      this.reading_.isEmpty
    ) {
      stateCallback(this.buildChoosingCandidateState(maybeNotEmptyState));
      return true;
    }

    // Esc hit.
    if (key.name === KeyName.ESC) {
      if (maybeNotEmptyState instanceof NotEmpty === false) {
        return false;
      }

      if (this.escKeyClearsEntireComposingBuffer_) {
        this.reset();
        stateCallback(new EmptyIgnoringPrevious());
        return true;
      }

      if (!this.reading_.isEmpty) {
        this.reading_.clear();
        if (!this.builder_.length) {
          stateCallback(new EmptyIgnoringPrevious());
        } else {
          stateCallback(this.buildInputtingState());
        }
      } else {
        stateCallback(this.buildInputtingState());
      }
      return true;
    }

    // Tab key.
    if (key.name === KeyName.TAB) {
      return this.handleTabKey(key, state, stateCallback, errorCallback);
    }

    // Cursor keys.
    if (key.isCursorKeys) {
      return this.handleCursorKeys(key, state, stateCallback, errorCallback);
    }

    // Backspace and Del.
    if (key.isDeleteKeys) {
      return this.handleDeleteKeys(key, state, stateCallback, errorCallback);
    }

    // Enter.
    if (key.name === KeyName.RETURN) {
      if (maybeNotEmptyState instanceof NotEmpty === false) {
        return false;
      }

      if (!this.reading_.isEmpty) {
        errorCallback();
        stateCallback(this.buildInputtingState());
        return true;
      }

      // See if we are in Marking state, and, if a valid mark, accept it.
      if (state instanceof Marking) {
        let marking = state as Marking;
        if (marking.acceptable) {
          if (this.languageModel_ instanceof WebLanguageModel) {
            (this.languageModel_ as WebLanguageModel).addUserPhrase(
              marking.reading,
              marking.markedText
            );
          }
          stateCallback(this.buildInputtingState());
        } else {
          errorCallback();
          stateCallback(
            this.buildMarkingState(marking.markStartGridCursorIndex)
          );
        }
        return true;
      }

      let inputtingState = this.buildInputtingState();
      // Steal the composingBuffer built by the inputting state.
      let committingState = new Committing(inputtingState.composingBuffer);
      stateCallback(committingState);
      this.reset();
      return true;
    }

    // Punctuation key: backtick or grave accent.
    if (
      simpleAscii === kPunctuationListKey &&
      this.languageModel_.hasUnigramsForKey(kPunctuationListUnigramKey)
    ) {
      if (this.reading_.isEmpty) {
        this.builder_.insertReadingAtCursor(kPunctuationListUnigramKey);

        let evictedText = this.popEvictedTextAndWalk();

        let inputtingState = this.buildInputtingState();
        inputtingState.evictedText = evictedText;
        let choosingCandidateState =
          this.buildChoosingCandidateState(inputtingState);
        stateCallback(inputtingState);
        stateCallback(choosingCandidateState);
      } else {
        // Punctuation ignored if a bopomofo reading is active..
        errorCallback();
      }
      return true;
    }

    if (key.ascii != "") {
      let chrStr = key.ascii;
      let unigram = "";
      // if (key.ctrlPressed) {
      //   unigram = kCtrlPunctuationKeyPrefix + chrStr;
      //   if (this.handlePunctuation(unigram, stateCallback, errorCallback)) {
      //     return true;
      //   }
      //   return false;
      // }

      // Bopomofo layout-specific punctuation handling.
      unigram =
        kPunctuationKeyPrefix +
        GetKeyboardLayoutName(this.reading_.keyboardLayout) +
        "_" +
        chrStr;
      if (this.handlePunctuation(unigram, stateCallback, errorCallback)) {
        return true;
      }

      // Not handled, try generic punctuations.
      unigram = kPunctuationKeyPrefix + chrStr;
      if (this.handlePunctuation(unigram, stateCallback, errorCallback)) {
        return true;
      }

      // Upper case letters.
      if (
        simpleAscii.length === 1 &&
        simpleAscii >= "A" &&
        simpleAscii <= "Z"
      ) {
        if (this.putLowercaseLettersToComposingBuffer_) {
          unigram = kLetterPrefix + chrStr;

          // Ignore return value, since we always return true below.
          this.handlePunctuation(unigram, stateCallback, errorCallback);
        } else {
          // If current state is *not* NonEmpty, it must be Empty.
          if (maybeNotEmptyState instanceof NotEmpty === false) {
            // We don't need to handle this key.
            return false;
          }

          // First, commit what's already in the composing buffer.
          let inputtingState = this.buildInputtingState();
          // Steal the composingBuffer built by the inputting state.
          let committingState = new Committing(inputtingState.composingBuffer);
          stateCallback(committingState);

          // Then we commit that single character.
          stateCallback(new Committing(chrStr));
          this.reset();
        }
        return true;
      }
    }

    // No key is handled. Refresh and consume the key.
    if (maybeNotEmptyState instanceof NotEmpty) {
      errorCallback();
      stateCallback(this.buildInputtingState());
      return true;
    }

    return false;
  }

  candidateSelected(
    candidate: string,
    stateCallback: (state: InputState) => void
  ): void {
    if (this.traditionalMode_) {
      this.reset();
      stateCallback(new Committing(candidate));
      return;
    }

    this.pinNode(candidate);
    stateCallback(this.buildInputtingState());
  }

  candidatePanelCancelled(stateCallback: (state: InputState) => void): void {
    if (this.traditionalMode_) {
      this.reset();
      stateCallback(new EmptyIgnoringPrevious());
      return;
    }

    stateCallback(this.buildInputtingState());
  }

  handlePunctuationKeyInCandidatePanelForTraditionalMode(
    key: Key,
    defaultCandidate: string,
    stateCallback: (state: InputState) => void,
    errorCallback: () => void
  ): boolean {
    let chrStr: string = key.ascii;
    let customPunctuation =
      kPunctuationKeyPrefix +
      GetKeyboardLayoutName(this.reading_.keyboardLayout) +
      "_" +
      chrStr;
    let punctuation = kPunctuationKeyPrefix + chrStr;
    let shouldAutoSelectCandidate =
      this.reading_.isValidKey(chrStr) ||
      this.languageModel_.hasUnigramsForKey(customPunctuation) ||
      this.languageModel_.hasUnigramsForKey(punctuation);
    if (!shouldAutoSelectCandidate) {
      if (chrStr.length == 1 && chrStr >= "A" && chrStr <= "Z") {
        let letter = kLetterPrefix + chrStr;
        if (this.languageModel_.hasUnigramsForKey(letter)) {
          shouldAutoSelectCandidate = true;
        }
      }
    }
    if (shouldAutoSelectCandidate) {
      stateCallback(new Committing(defaultCandidate));
      this.reset();
      this.handle(key, new Empty(), stateCallback, errorCallback);
      return true;
    }

    errorCallback();
    return false;
  }

  reset(): void {
    this.reading_.clear();
    this.builder_.clear();
    this.walkedNodes_ = [];
  }

  private getComposedString(builderCursor: number): ComposedString {
    // To construct an Inputting state, we need to first retrieve the entire
    // composing buffer from the current grid, then split the composed string into
    // head and tail, so that we can insert the current reading (if not-empty)
    // between them.
    //
    // We'll also need to compute the UTF-8 cursor index. The idea here is we use
    // a "running" index that will eventually catch the cursor index in the
    // builder. The tricky part is that if the spanning length of the node that
    // the cursor is at does not agree with the actual codepoint count of the
    // node's value, we'll need to move the cursor at the end of the node to avoid
    // confusions.

    let runningCursor: number = 0; // spanning-length-based, like the builder cursor
    let composed: string = "";
    let composedCursor: number = 0; // UTF-8 (so "byte") cursor per fcitx5 requirement.

    let tooltip = "";

    for (let anchor of this.walkedNodes_) {
      let node = anchor.node;
      if (node === undefined) {
        continue;
      }
      let value = node.currentKeyValue.value;
      composed += value;

      // No work if runningCursor has already caught up with builderCursor.
      if (runningCursor === builderCursor) {
        continue;
      }
      let spanningLength = anchor.spanningLength;
      // Simple case: if the running cursor is behind, add the spanning length.
      if (runningCursor + spanningLength <= builderCursor) {
        composedCursor += value.length;
        runningCursor += spanningLength;
        continue;
      }

      let distance = builderCursor - runningCursor;
      let u32Value = _.toArray(value);
      let cpLen = Math.min(distance, u32Value.length);
      let actualString = _.join(u32Value.slice(0, cpLen), "");
      composedCursor += actualString.length;
      runningCursor += distance;

      // Create a tooltip to warn the user that their cursor is between two
      // readings (syllables) even if the cursor is not in the middle of a
      // composed string due to its being shorter than the number of readings.
      if (u32Value.length < spanningLength) {
        // builderCursor is guaranteed to be > 0. If it was 0, we wouldn't even
        // reach here due to runningCursor having already "caught up" with
        // builderCursor. It is also guaranteed to be less than the size of the
        // builder's readings for the same reason: runningCursor would have
        // already caught up.
        let prevReading = this.builder_.readings[builderCursor - 1];
        let nextReading = this.builder_.readings[builderCursor];
        tooltip = this.localizedStrings_.cursorIsBetweenSyllables(
          prevReading,
          nextReading
        );
      }
    }

    let head = composed.substring(0, composedCursor);
    let tail = composed.substring(composedCursor, composed.length);
    return new ComposedString(head, tail, tooltip);
  }

  private handleTabKey(
    key: Key,
    state: InputState,
    stateCallback: (state: InputState) => void,
    errorCallback: () => void
  ): boolean {
    if (state instanceof Inputting == false) {
      errorCallback();
      return true;
    }

    let inputting: Inputting = state as Inputting;

    if (!this.reading_.isEmpty) {
      errorCallback();
      return true;
    }

    let candidates = this.buildChoosingCandidateState(inputting).candidates;
    if (!candidates.length) {
      errorCallback();
      return true;
    }

    let cursorIndex = this.actualCandidateCursorIndex;
    let length = 0;
    let currentNode = new NodeAnchor();

    for (let node of this.walkedNodes_) {
      length += node.spanningLength;
      if (length >= cursorIndex) {
        currentNode = node;
        break;
      }
    }

    let currentValue = currentNode.node?.currentKeyValue.value;
    let currentIndex = 0;
    let score = currentNode.node?.score ?? 0;
    if (score < kSelectedCandidateScore) {
      // Once the user never select a candidate for the node, we start from the
      // first candidate, so the user has a chance to use the unigram with two or
      // more characters when type the tab key for the first time.
      //
      // In other words, if a user type two BPMF readings, but the score of seeing
      // them as two unigrams is higher than a phrase with two characters, the
      // user can just use the longer phrase by typing the tab key.
      if (candidates[0] === currentValue) {
        // If the first candidate is the value of the current node, we use next
        // one.
        if (key.shiftPressed) {
          currentIndex = candidates.length - 1;
        } else {
          currentIndex = 1;
        }
      }
    } else {
      for (let candidate of candidates) {
        if (candidate == currentNode.node?.currentKeyValue.value) {
          if (key.shiftPressed) {
            currentIndex == 0
              ? (currentIndex = candidates.length - 1)
              : currentIndex--;
          } else {
            currentIndex++;
          }
          break;
        }
        currentIndex++;
      }
    }

    if (currentIndex >= candidates.length) {
      currentIndex = 0;
    }

    this.pinNode(
      candidates[currentIndex],
      /*useMoveCursorAfterSelectionSetting=*/ false
    );
    stateCallback(this.buildInputtingState());
    return true;
  }

  private handleCursorKeys(
    key: Key,
    state: InputState,
    stateCallback: (state: InputState) => void,
    errorCallback: () => void
  ): boolean {
    if (
      state instanceof Inputting === false &&
      state instanceof Marking === false
    ) {
      return false;
    }

    let markBeginCursorIndex = this.builder_.cursorIndex;
    if (state instanceof Marking) {
      markBeginCursorIndex = (state as Marking).markStartGridCursorIndex;
    }

    if (!this.reading_.isEmpty) {
      errorCallback();
      stateCallback(this.buildInputtingState());
      return true;
    }

    let isValidMove = false;
    switch (key.name) {
      case KeyName.LEFT:
        if (this.builder_.cursorIndex > 0) {
          this.builder_.cursorIndex -= 1;
          isValidMove = true;
        }
        break;
      case KeyName.RIGHT:
        if (this.builder_.cursorIndex < this.builder_.length) {
          this.builder_.cursorIndex += 1;
          isValidMove = true;
        }
        break;
      case KeyName.HOME:
        this.builder_.cursorIndex = 0;
        isValidMove = true;
        break;
      case KeyName.END:
        this.builder_.cursorIndex = this.builder_.length;
        isValidMove = true;
        break;
      default:
        // Ignored.
        break;
    }

    if (!isValidMove) {
      errorCallback();
    }

    if (key.shiftPressed && this.builder_.cursorIndex != markBeginCursorIndex) {
      stateCallback(this.buildMarkingState(markBeginCursorIndex));
    } else {
      stateCallback(this.buildInputtingState());
    }
    return true;
  }

  private handleDeleteKeys(
    key: Key,
    state: InputState,
    stateCallback: (state: InputState) => void,
    errorCallback: () => void
  ): boolean {
    if (state instanceof NotEmpty === false) {
      return false;
    }

    if (this.reading_.hasToneMarkerOnly) {
      this.reading_.clear();
    } else if (this.reading_.isEmpty) {
      let isValidDelete = false;

      if (key.name === KeyName.BACKSPACE && this.builder_.cursorIndex > 0) {
        this.builder_.deleteReadingBeforeCursor();
        isValidDelete = true;
      } else if (
        key.name === KeyName.DELETE &&
        this.builder_.cursorIndex < this.builder_.length
      ) {
        this.builder_.deleteReadingAfterCursor();
        isValidDelete = true;
      }
      if (!isValidDelete) {
        errorCallback();
        stateCallback(this.buildInputtingState());
        return true;
      }
      this.walk();
    } else {
      if (key.name === KeyName.BACKSPACE) {
        this.reading_.backspace();
      } else {
        // Del not supported when bopomofo reading is active.
        errorCallback();
      }
    }

    if (this.reading_.isEmpty && this.builder_.length === 0) {
      // Cancel the previous input state if everything is empty now.
      stateCallback(new EmptyIgnoringPrevious());
    } else {
      stateCallback(this.buildInputtingState());
    }
    return true;
  }

  private handlePunctuation(
    punctuationUnigramKey: string,
    stateCallback: (state: InputState) => void,
    errorCallback: () => void
  ): boolean {
    if (!this.languageModel_.hasUnigramsForKey(punctuationUnigramKey)) {
      return false;
    }

    if (!this.reading_.isEmpty) {
      errorCallback();
      stateCallback(this.buildInputtingState());
      return true;
    }

    this.builder_.insertReadingAtCursor(punctuationUnigramKey);
    let evictedText = this.popEvictedTextAndWalk();

    let inputtingState = this.buildInputtingState();
    inputtingState.evictedText = evictedText;
    stateCallback(inputtingState);

    if (this.traditionalMode_ && this.reading_.isEmpty) {
      let candidateState = this.buildChoosingCandidateState(inputtingState);
      this.reset();
      if (candidateState.candidates.length === 1) {
        let text = candidateState.candidates[0];
        stateCallback(new Committing(text));
      } else {
        stateCallback(candidateState);
      }
    }

    return true;
  }

  private buildChoosingCandidateState(
    nonEmptyState: NotEmpty
  ): ChoosingCandidate {
    let anchoredNodes = this.builder_.grid.nodesCrossingOrEndingAt(
      this.actualCandidateCursorIndex
    );

    // sort the nodes, so that longer nodes (representing longer phrases) are
    // placed at the top of the candidate list
    anchoredNodes.sort((a, b) => {
      return (b.node?.key.length ?? 0) - (a.node?.key.length ?? 0);
    });

    let candidates: string[] = [];
    for (let anchor of anchoredNodes) {
      let nodeCandidates = anchor.node?.candidates;
      if (nodeCandidates != undefined) {
        for (let kv of nodeCandidates) {
          candidates.push(kv.value);
        }
      }
    }

    return new ChoosingCandidate(
      nonEmptyState.composingBuffer,
      nonEmptyState.cursorIndex,
      candidates
    );
  }

  private buildInputtingState(): Inputting {
    let composedString = this.getComposedString(this.builder_.cursorIndex);

    let head = composedString.head;
    let reading = this.reading_.composedString;
    let tail = composedString.tail;

    let composingBuffer = head + reading + tail;
    let cursorIndex = head.length + reading.length;
    return new Inputting(composingBuffer, cursorIndex, composedString.tooltip);
  }

  private buildMarkingState(beginCursorIndex: number): Marking {
    // We simply build two composed strings and use the delta between the shorter
    // and the longer one as the marked text.
    let from = this.getComposedString(beginCursorIndex);
    let to = this.getComposedString(this.builder_.cursorIndex);
    let composedStringCursorIndex = to.head.length;
    let composed = to.head + to.tail;
    let fromIndex = beginCursorIndex;
    let toIndex = this.builder_.cursorIndex;

    if (beginCursorIndex > this.builder_.cursorIndex) {
      [from, to] = [to, from];
      [fromIndex, toIndex] = [toIndex, fromIndex];
    }

    // Now from is shorter and to is longer. The marked text is just the delta.
    let head = from.head;
    let marked = to.head.substring(from.head.length);
    let tail = to.tail;

    // Collect the readings.
    let readings = this.builder_.readings.slice(fromIndex, toIndex);

    let readingUiText = _.join(readings, " "); // What the user sees.
    let readingValue = _.join(readings, "-"); // What is used for adding a user phrase.

    let isValid = false;
    let status = "";
    // Validate the marking.
    if (readings.length < kMinValidMarkingReadingCount) {
      status = this.localizedStrings_.syllablesRequired(
        kMinValidMarkingReadingCount
      );
    } else if (readings.length > kMaxValidMarkingReadingCount) {
      status = this.localizedStrings_.syllableMaximum(
        kMaxValidMarkingReadingCount
      );
    } else if (MarkedPhraseExists(this.languageModel_, readingValue, marked)) {
      status = this.localizedStrings_.phraseAlreadyExists();
    } else {
      status = this.localizedStrings_.pressEnterToAddThePhrase();
      isValid = true;
    }

    let tooltip = this.localizedStrings_.markedWithSyllablesAndStatus(
      marked,
      readingUiText,
      status
    );

    return new Marking(
      composed,
      composedStringCursorIndex,
      tooltip,
      beginCursorIndex,
      head,
      marked,
      tail,
      readingValue,
      isValid
    );
  }

  private get actualCandidateCursorIndex(): number {
    let cursorIndex = this.builder_.cursorIndex;
    if (this.selectPhraseAfterCursorAsCandidate_) {
      if (cursorIndex < this.builder_.length) {
        ++cursorIndex;
      }
    } else {
      // Cursor must be in the middle or right after a node. So if the cursor is
      // at the beginning, move by one.
      if (!cursorIndex && this.builder_.length > 0) {
        ++cursorIndex;
      }
    }
    return cursorIndex;
  }

  private popEvictedTextAndWalk() {
    // in an ideal world, we can as well let the user type forever, but because
    // the Viterbi algorithm has a complexity of O(N^2), the walk will become
    // slower as the number of nodes increase, therefore we need to "pop out"
    // overflown text -- they usually lose their influence over the whole MLE
    // anyway -- so that when the user type along, the already composed text at
    // front will be popped out
    let evictedText: string = "";

    if (
      this.builder_.grid.width > this.composingBufferSize &&
      this.walkedNodes_.length != 0
    ) {
      let anchor = this.walkedNodes_[0];
      evictedText = anchor.node?.currentKeyValue.value ?? "";
      this.builder_.removeHeadReadings(anchor.spanningLength);
    }

    this.walk();
    return evictedText;
  }

  private fixNodesIfRequired() {
    let width = this.builder_.grid.width;
    if (width > kMaxComposingBufferNeedsToWalkSize) {
      let index = 0;
      for (let node of this.walkedNodes_) {
        if (index >= width - kMaxComposingBufferNeedsToWalkSize) {
          break;
        }
        if (node.node == undefined) {
          continue;
        }
        if (node.node.score < kSelectedCandidateScore) {
          let candidate = node.node.currentKeyValue.value;
          this.builder_.grid.fixNodeSelectedCandidate(
            index + node.spanningLength,
            candidate
          );
        }
        index += node.spanningLength;
      }
    }
  }

  private pinNode(
    candidate: string,
    useMoveCursorAfterSelectionSetting: boolean = true
  ): void {
    let cursorIndex: number = this.actualCandidateCursorIndex;
    let selectedNode = this.builder_.grid.fixNodeSelectedCandidate(
      cursorIndex,
      candidate
    );
    let score = selectedNode.node?.scoreForCandidate(candidate);
    if (score != undefined) {
      if (score > kNoOverrideThreshold) {
        this.userOverrideModel_!.observe(
          this.walkedNodes_,
          cursorIndex,
          candidate,
          new Date().getTime()
        );
      }
    }

    this.walk();

    if (useMoveCursorAfterSelectionSetting && this.moveCursorAfterSelection_) {
      let nextPosition = 0;
      for (let node of this.walkedNodes_) {
        if (nextPosition >= cursorIndex) {
          break;
        }
        nextPosition += node.spanningLength;
      }
      if (nextPosition <= this.builder_.length) {
        this.builder_.cursorIndex = nextPosition;
      }
    }
  }

  private walk() {
    // retrieve the most likely trellis, i.e. a Maximum Likelihood Estimation of
    // the best possible Mandarin characters given the input syllables, using
    // the Viterbi algorithm implemented in the Gramambular library.
    let walker = new Walker(this.builder_.grid);

    // the walker traces the trellis from the end
    let nodes = walker.walk(0);

    this.walkedNodes_ = nodes;
  }

  dumpPaths(): NodeAnchor[][] {
    let walker = new Walker(this.builder_.grid);

    let paths = walker.dumpPaths(this.builder_.grid.width);
    let result: NodeAnchor[][] = [];
    for (let path of paths) {
      result.push(path.reverse());
    }
    return result;
  }
}

function MarkedPhraseExists(
  languageModel_: LanguageModel,
  readingValue: string,
  marked: string
) {
  let phrases = languageModel_.unigramsForKey(readingValue);
  for (let unigram of phrases) {
    if (unigram.keyValue.value == marked) {
      return true;
    }
  }
  return false;
}
