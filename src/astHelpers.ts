import * as AST from "estree";

export const toPromisify = (name: string, expression: AST.Expression): AST.VariableDeclaration => {
  return {
    type: "VariableDeclaration",
    kind: "const",
    declarations: [
      {
        type: "VariableDeclarator",
        id: { type: "Identifier", name: name },
        init: {
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            object: { type: "Identifier", name: "util" },
            computed: false,
            optional: false,
            property: { type: "Identifier", name: "promisify" },
          },
          optional: false,
          arguments: [expression],
        },
      },
    ],
  };
};

export const toAsyncIIFE = (body: AST.Statement[]): AST.ExpressionStatement => {
  return {
    type: "ExpressionStatement",
    expression: {
      type: "CallExpression",
      callee: {
        type: "ArrowFunctionExpression",
        params: [],
        body: {
          type: "BlockStatement",
          body: body,
        },
        async: true,
        expression: false,
      },
      optional: false,
      arguments: [],
    },
  };
};

export const toAwait = (name: string, statement: any): AST.VariableDeclaration => {
  return {
    type: "VariableDeclaration",
    declarations: [
      {
        type: "VariableDeclarator",
        id: {
          type: "Identifier",
          name: name,
        },
        init: {
          type: "AwaitExpression",
          argument: statement,
        },
      },
    ],
    kind: "const",
  };
};
