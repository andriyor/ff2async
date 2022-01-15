// @ts-nocheck

import fs from "fs";

import { parse } from "meriyah";
import astray from "astray";
import escodegen from "escodegen";
import { ESLint } from "eslint";
import * as AST from "estree";

import { toAsyncIIFE, toAwait, toPromisify } from "./astHelpers";

const code = fs.readFileSync("code/ffExample.js", "utf8");
const codeAST = parse(code);

const expressionStatementsWithSlot: {
  fromSlot: boolean;
  statement: astray.Path<astray.ESTreeMap, unknown>;
}[] = [];
let argsToVar: string[] = [];
const expressionsToPromisify: Record<string, AST.Expression> = {};
let ffExpressionStatement;

astray.walk(codeAST, {
  ExpressionStatement(callExpression) {
    // find top level ff
    if (callExpression.expression?.callee?.object?.callee?.object?.callee?.name === "ff") {
      ffExpressionStatement = callExpression;
      astray.walk(callExpression, {
        CallExpression(callExpression) {
          if (callExpression.callee.name === "ff") {
            astray.walk(callExpression, {
              FunctionExpression(functionExpression) {
                argsToVar = [...argsToVar, ...functionExpression.params.map((identifier) => identifier.name)];
              },
              ExpressionStatement(expressionStatement) {
                let withSlot = false;
                astray.walk(expressionStatement, {
                  CallExpression(callExpression, state) {
                    if (callExpression.callee.property && callExpression.callee.property.name === "slot") {
                      withSlot = true;
                      // remove last f.slot() argument
                      expressionStatement.expression.arguments.pop();
                      // promisify callback functions
                      if (expressionStatement.expression.callee.name) {
                        const promisedName = `promised${expressionStatement.expression.callee.name}`;
                        expressionsToPromisify[promisedName] = { ...expressionStatement.expression.callee };
                        expressionStatement.expression.callee.name = promisedName;
                      }

                      if (expressionStatement.expression.callee.object && expressionStatement.expression.callee.property) {
                        const promisedName = `promised${
                          expressionStatement.expression.callee.object.name + expressionStatement.expression.callee.property.name
                        }`;
                        expressionsToPromisify[promisedName] = { ...expressionStatement.expression.callee };

                        expressionStatement.expression.callee.name = promisedName;
                        expressionStatement.expression.callee.type = "Identifier";
                        delete expressionStatement.expression.callee.object;
                        delete expressionStatement.expression.callee.property;
                      }
                      expressionStatementsWithSlot.push({
                        fromSlot: true,
                        statement: expressionStatement,
                      });
                    }
                  },
                });
                if (!withSlot) {
                  if (
                    expressionStatement.expression.callee.object.name === "f" &&
                    expressionStatement.expression.callee.property.name === "pass"
                  ) {
                    expressionStatementsWithSlot.push({
                      fromSlot: false,
                      statement: expressionStatement.expression.arguments[0],
                    });
                  }
                }
              },
            });
          }
        },
      });
    }
  },
});

const astStatements: unknown[] = [];
expressionStatementsWithSlot.forEach((astStatement, index) => {
  if (astStatement.fromSlot) {
    astStatements.push(toAwait(argsToVar[index], astStatement.statement));
  } else {
    astStatements.push(astStatement.statement);
  }
});

(async () => {
  // use eslint to remove extra semicolons and extra parens added by escodegen
  // TODO: replace initial ff function with async IIFE
  const eslint = new ESLint({ fix: true });
  const promisified = Object.entries(expressionsToPromisify).map(([name, memberExpression]) => toPromisify(name, memberExpression));
  const asyncIIFE = toAsyncIIFE([...promisified, ...astStatements]);
  const results = await eslint.lintText(escodegen.generate(asyncIIFE));
  console.log(results[0].output);
})().catch((error) => {
  process.exitCode = 1;
  console.error(error);
});
