// LeafTutor CodeMirror 6 bundle entry. Built once (esbuild) and vendored at
// static/vendor/codemirror/codemirror.bundle.js. Exposes a flat toolkit on
// window.LTCodeMirror so the no-module Deep Coding page can consume it.
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine,
         highlightActiveLineGutter, drawSelection, rectangularSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput,
         bracketMatching, indentUnit } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { lintGutter, setDiagnostics, linter } from "@codemirror/lint";
import { java } from "@codemirror/lang-java";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";

window.LTCodeMirror = {
  EditorState, EditorView, Compartment,
  keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, rectangularSelection,
  defaultKeymap, history, historyKeymap, indentWithTab,
  syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, indentUnit,
  closeBrackets, closeBracketsKeymap,
  lintGutter, setDiagnostics, linter,
  langs: { java, python, cpp },
};
