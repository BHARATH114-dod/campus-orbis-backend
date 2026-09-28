/**
 * Campus Orbis — multi-language Courses content module.
 *
 * Generalizes the original Python Full Course (pythonCourseData.js) to all
 * five course languages: python, c, cpp, java, javascript. This file does
 * NOT replace pythonCourseData.js — Python's fully-authored Module 1 +
 * demo List lesson are imported as-is and reused verbatim, so the existing
 * /api/student/python-course/* routes keep working unchanged. Everything
 * here is purely additive.
 *
 * Every language gets the same 15-module outline shape (see OUTLINE below,
 * adapted per-language from the course brief). Only Python currently has
 * hand-authored lesson content; every other language is built entirely
 * from stubLesson() — a real, unlockable, completable lesson with
 * "content coming soon" learn material and a single-question review test —
 * exactly the same mechanism the existing Python course already uses for
 * its own un-authored modules (2, 3, 5-15). Nothing about the schema
 * changes when real content is authored for a language later; only a
 * lesson's `learn` / `test.questions` fields do.
 */

const { COURSE: PY_COURSE } = require('./pythonCourseData');
const JAVA_M3_15 = require('./javaModules3to15');
const C_M3_15 = require('./cModules3to15');
const CPP_M3_15 = require('./cppModules3to15');
const JS_M3_15 = require('./javascriptModules3to15');

let AUTO_ID = 0;
function qid(prefix) { AUTO_ID += 1; return `${prefix}${AUTO_ID}`; }

function stubTest(topic) {
  return {
    questions: [
      {
        id: qid('stubq'),
        type: 'mcq',
        text: `Quick check — have you read through the "${topic}" material above?`,
        options: ['Yes, I read it', 'I skimmed it', 'Not yet', 'I will come back later'],
        correct_index: 0
      }
    ]
  };
}

function stubLesson(order, title) {
  return {
    order,
    title,
    est_minutes: 10,
    content_ready: false,
    learn: {
      explanation: `Content for "${title}" is coming soon. Your instructor can publish the full lesson (explanation, syntax, examples, common mistakes) through the course content tools without changing where this lesson lives in the course.`,
      syntax: '',
      examples: [],
      important_points: [],
      common_mistakes: [],
      real_world: ''
    },
    practice: null,
    test: stubTest(title)
  };
}

// Same shape/signature as pythonCourseData.js's lesson() — used below to
// hand-author Module 1 for C/C++/Java/JavaScript so their first module is
// no longer a "coming soon" stub, matching Python's existing depth.
function lesson(order, title, estMinutes, learn, practice, test) {
  return { order, title, est_minutes: estMinutes, content_ready: true, learn, practice, test };
}

// ---------------------------------------------------------------------------
// Module 1 content — C, C++, Java, JavaScript (fully authored, matching
// Python's Module 1 depth/format). Every other module (2-15) for these four
// languages remains stubLesson()-generated, same as Python's own
// un-authored modules — see buildStubCourse below for how these plug in.
// ---------------------------------------------------------------------------
const C_MODULE1_LESSONS = [
  lesson(1, 'Introduction to C', 6, {
    explanation: 'C is a general-purpose, compiled programming language created in 1972. It gives direct control over memory and hardware, and is the foundation most other languages (C++, Java, Python\'s own interpreter) are built on or influenced by.',
    syntax: '',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    printf("Hello, World!");\n    return 0;\n}', output: 'Hello, World!' }],
    important_points: ['C is compiled, not interpreted — code is translated to machine code before running.', 'C is statically typed — every variable\'s type is fixed at compile time.', 'Every C program needs a main() function as its entry point.'],
    common_mistakes: ['Forgetting the semicolon at the end of a statement.', 'Forgetting #include <stdio.h> before using printf.'],
    real_world: 'Operating systems (Linux, Windows kernels) and embedded devices are written largely in C.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    printf("Hello, World!");\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'C is an example of which type of language?', options: ['Interpreted only', 'Compiled', 'Markup', 'Query'], correct_index: 1 },
      { id: qid('q'), type: 'truefalse', text: 'Every C program must have a main() function.', correct_index: 0, options: ['True', 'False'] },
      { id: qid('q'), type: 'code', text: 'Write a C program that prints exactly: Hello, Campus Orbis!', language: 'c', starter_code: '#include <stdio.h>\nint main() {\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '', expected_output: 'Hello, Campus Orbis!' }] }
    ]
  }),
  lesson(2, 'C Features', 5, {
    explanation: 'C is fast, portable across platforms, and gives low-level access to memory through pointers. It has a small core language with a rich standard library, and most other languages borrow its syntax for loops, conditionals, and functions.',
    syntax: '',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    printf("Size of int: %lu bytes", sizeof(int));\n    return 0;\n}', output: 'Size of int: 4 bytes' }],
    important_points: ['Procedural language — code is organized into functions.', 'Gives direct memory access via pointers.', 'Extremely portable — the same C code compiles on almost any platform.'],
    common_mistakes: ['Assuming C automatically manages memory the way Python or Java do — it does not.'],
    real_world: 'Device drivers and performance-critical systems (like database engines) are still written in C for its speed and control.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    printf("Size of int: %lu bytes", sizeof(int));\n    return 0;\n}\n' }, stubTest('C Features')),
  lesson(3, 'Installing / Running C', 5, {
    explanation: 'C source code (a .c file) must be compiled into an executable before it can run — typically with gcc. On Campus Orbis, you can compile and run C instantly using the built-in compiler, no local install needed.',
    syntax: 'gcc filename.c -o output && ./output',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    printf("%d", 1 + 1);\n    return 0;\n}', output: '2' }],
    important_points: ['.c is the standard source file extension for C.', 'Compiling catches many errors before the program ever runs.'],
    common_mistakes: ['Trying to run a .c file directly without compiling it first.'],
    real_world: 'Every C-based tool you use (from git to your terminal) went through this same compile step before it could run.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    printf("%d", 1 + 1);\n    return 0;\n}\n' }, stubTest('Installing / Running C')),
  lesson(4, 'Structure of a C Program', 6, {
    explanation: 'A C program is built from: preprocessor directives (#include), a main() function (the entry point), variable declarations, statements, and a return value indicating success (0) or failure.',
    syntax: '#include <stdio.h>\nint main() {\n    // statements\n    return 0;\n}',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    int x = 5;\n    printf("x = %d", x);\n    return 0;\n}', output: 'x = 5' }],
    important_points: ['return 0; signals the program finished successfully.', 'Statements execute top to bottom inside main().'],
    common_mistakes: ['Forgetting return 0; at the end of main().', 'Mismatched curly braces { }.'],
    real_world: 'This exact skeleton — includes, main(), return — is the shape of nearly every C program you\'ll ever read.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    int x = 5;\n    printf("x = %d", x);\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'What does `return 0;` at the end of main() typically indicate?', options: ['An error occurred', 'The program ran successfully', 'The program is paused', 'Nothing, it is optional'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Write a C program that declares an int variable x = 10 and prints it.', language: 'c', starter_code: '#include <stdio.h>\nint main() {\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '', expected_output: '10' }] }
    ]
  }),
  lesson(5, 'Variables', 6, {
    explanation: 'A variable in C is a named storage location with a fixed type, declared before use. Unlike Python, C requires you to state the type up front, and that type never changes.',
    syntax: 'type variable_name = value;',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    int age = 20;\n    printf("%d", age);\n    return 0;\n}', output: '20' }],
    important_points: ['Variables must be declared with a type before use.', 'C variable names are case-sensitive.', 'Uninitialized variables hold garbage values, not 0.'],
    common_mistakes: ['Using a variable before declaring/initializing it.', 'Starting a variable name with a digit.'],
    real_world: 'Explicit typing is why C programs can be so memory-efficient — the compiler knows exactly how many bytes each variable needs.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    int age = 20;\n    printf("%d", age);\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which of these is a valid C variable declaration?', options: ['int 2total;', 'int total_2;', 'int total-2;', 'int class;'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Declare an int variable named city_code, set it to 500, and print it.', language: 'c', starter_code: '#include <stdio.h>\nint main() {\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '', expected_output: '500' }] }
    ]
  }),
  lesson(6, 'Data Types', 6, {
    explanation: 'C\'s core built-in types are int (whole numbers), float/double (decimals), char (a single character), and void (no value). Each has a fixed size in memory, checkable with sizeof().',
    syntax: 'int, float, double, char, void',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    printf("%lu %lu %lu", sizeof(int), sizeof(float), sizeof(char));\n    return 0;\n}', output: '4 4 1' }],
    important_points: ['double has more precision than float.', 'char stores exactly one character (in single quotes).', 'sizeof() shows exactly how many bytes a type uses.'],
    common_mistakes: ['Using single quotes for a string (should be double quotes) or double quotes for a single char.'],
    real_world: 'Choosing float vs double affects both memory usage and precision in scientific/financial C programs.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    printf("%lu %lu %lu", sizeof(int), sizeof(float), sizeof(char));\n    return 0;\n}\n' }, stubTest('Data Types')),
  lesson(7, 'Input and Output', 6, {
    explanation: 'printf() writes formatted output; scanf() reads formatted input. Both use format specifiers (%d for int, %f for float, %c for char) to match the data type being read or printed.',
    syntax: 'scanf("%d", &variable);',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    int n;\n    scanf("%d", &n);\n    printf("You entered %d", n);\n    return 0;\n}', output: '(reads a number)\nYou entered <n>' }],
    important_points: ['scanf needs the & (address-of) operator before the variable.', 'The format specifier in scanf/printf must match the variable\'s type.'],
    common_mistakes: ['Forgetting the & in scanf("%d", &n) — a very common bug.'],
    real_world: 'Command-line utilities (like a simple calculator) rely on scanf/printf for their entire interaction.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    int n;\n    scanf("%d", &n);\n    printf("You entered %d", n);\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'What must precede a variable name in scanf() to store input into it?', options: ['*', '&', '#', '%'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an integer n and print its double (n * 2).', language: 'c', starter_code: '#include <stdio.h>\nint main() {\n    int n;\n    scanf("%d", &n);\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '4', expected_output: '8' }, { input: '10', expected_output: '20' }] }
    ]
  }),
  lesson(8, 'Type Casting', 5, {
    explanation: 'Type casting converts a value from one type to another, either implicitly (C does it automatically in mixed expressions) or explicitly using (type)value.',
    syntax: '(type) value',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    float f = (float) 7 / 2;\n    printf("%.1f", f);\n    return 0;\n}', output: '3.5' }],
    important_points: ['Integer division (7 / 2) truncates to 3 unless one operand is cast to float first.', 'Explicit casts make intent clear and avoid surprises.'],
    common_mistakes: ['Dividing two ints and expecting a decimal result without casting.'],
    real_world: 'Averaging test scores stored as ints requires a cast to float to avoid losing the decimal part.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    float f = (float) 7 / 2;\n    printf("%.1f", f);\n    return 0;\n}\n' }, stubTest('Type Casting')),
  lesson(9, 'Operators', 6, {
    explanation: 'C provides arithmetic (+ - * / % ), relational (== != < > <= >=), logical (&& || !), and assignment (= += -= ...) operators, very similar to what most later languages copied from C.',
    syntax: 'a + b, a % b',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    printf("%d %d", 7 / 2, 7 % 2);\n    return 0;\n}', output: '3 1' }],
    important_points: ['/ between two ints does integer (truncating) division.', '&& and || are logical AND/OR, not & and |, which are bitwise.'],
    common_mistakes: ['Using & instead of && (bitwise AND instead of logical AND) in a condition.'],
    real_world: 'Splitting a total amount into whole units and a remainder (billing, change-making) uses / and % together, exactly like this.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    printf("%d %d", 7 / 2, 7 % 2);\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'output', text: 'What does `printf("%d", 10 % 3);` output?', options: ['3', '1', '3.33', '0'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read two integers a and b (one per line) and print their sum.', language: 'c', starter_code: '#include <stdio.h>\nint main() {\n    int a, b;\n    scanf("%d %d", &a, &b);\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '2\n3', expected_output: '5' }, { input: '10\n20', expected_output: '30' }] }
    ]
  }),
  lesson(10, 'Comments', 4, {
    explanation: 'Comments document code and are ignored by the compiler. Use // for a single line, or /* ... */ for a block spanning multiple lines.',
    syntax: '// single line\n/* multi\n   line */',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    // prints a greeting\n    printf("Hi");\n    return 0;\n}', output: 'Hi' }],
    important_points: ['Comments should explain WHY the code does something, not just restate WHAT it does.', 'Block comments /* */ cannot be nested in standard C.'],
    common_mistakes: ['Leaving an unclosed /* comment, which silently swallows the rest of the file.'],
    real_world: 'Large C codebases (like the Linux kernel) rely heavily on comments to explain low-level, non-obvious logic.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    // prints a greeting\n    printf("Hi");\n    return 0;\n}\n' }, stubTest('Comments'))
];

const CPP_MODULE1_LESSONS = [
  lesson(1, 'Introduction to C++', 6, {
    explanation: 'C++ extends C with object-oriented programming (classes, objects), while keeping C\'s performance and low-level control. It\'s widely used for games, systems software, and competitive programming.',
    syntax: '',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    cout << "Hello, World!";\n    return 0;\n}', output: 'Hello, World!' }],
    important_points: ['C++ is a compiled, statically typed language, like C.', 'cout/cin (from <iostream>) replace C\'s printf/scanf for I/O.', 'C++ supports both procedural and object-oriented styles.'],
    common_mistakes: ['Forgetting #include <iostream> before using cout.', 'Forgetting `using namespace std;` and then writing cout instead of std::cout.'],
    real_world: 'Game engines (Unreal Engine) and many competitive-programming judges use C++ for its speed and OOP features together.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    cout << "Hello, World!";\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which header provides cout and cin in C++?', options: ['<stdio.h>', '<iostream>', '<string>', '<vector>'], correct_index: 1 },
      { id: qid('q'), type: 'truefalse', text: 'C++ supports object-oriented programming, unlike plain C.', correct_index: 0, options: ['True', 'False'] },
      { id: qid('q'), type: 'code', text: 'Write a C++ program that prints exactly: Hello, Campus Orbis!', language: 'cpp', starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '', expected_output: 'Hello, Campus Orbis!' }] }
    ]
  }),
  lesson(2, 'C++ Features', 5, {
    explanation: 'C++ adds classes/objects, function/operator overloading, templates, and the Standard Template Library (STL) on top of C, while still allowing raw pointers and manual memory management when needed.',
    syntax: '',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    cout << sizeof(int);\n    return 0;\n}', output: '4' }],
    important_points: ['Object-oriented: classes bundle data and behavior together.', 'The STL provides ready-made data structures (vector, map, set).', 'C++ is largely (but not 100%) backward compatible with C.'],
    common_mistakes: ['Assuming every valid C program is automatically valid, idiomatic C++.'],
    real_world: 'Adobe Photoshop and most AAA game engines are written primarily in C++ for performance with OOP structure.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    cout << sizeof(int);\n    return 0;\n}\n' }, stubTest('C++ Features')),
  lesson(3, 'Installing / Running C++', 5, {
    explanation: 'C++ source (a .cpp file) is compiled with a compiler like g++ into an executable. Campus Orbis\'s built-in compiler runs C++ instantly — no local setup required.',
    syntax: 'g++ filename.cpp -o output && ./output',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    cout << 1 + 1;\n    return 0;\n}', output: '2' }],
    important_points: ['.cpp is the standard C++ source file extension.', 'g++ is the most common C++ compiler.'],
    common_mistakes: ['Compiling a C++ file with a plain C compiler (gcc), which doesn\'t understand C++-only syntax.'],
    real_world: 'Competitive programmers on judges like Codeforces write and submit .cpp files exactly this way.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    cout << 1 + 1;\n    return 0;\n}\n' }, stubTest('Installing / Running C++')),
  lesson(4, 'Structure of a C++ Program', 6, {
    explanation: 'A C++ program has: #include directives, an optional `using namespace std;`, a main() function as the entry point, statements, and a return value.',
    syntax: '#include <iostream>\nusing namespace std;\nint main() {\n    // statements\n    return 0;\n}',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    int x = 5;\n    cout << "x = " << x;\n    return 0;\n}', output: 'x = 5' }],
    important_points: ['The << operator "streams" values into cout for printing.', 'main() always returns an int (0 for success).'],
    common_mistakes: ['Mixing up << (stream insertion) with < (less than).'],
    real_world: 'Every C++ program you\'ll write in this course starts from exactly this skeleton.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int x = 5;\n    cout << "x = " << x;\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which operator is used to send output to cout?', options: ['>>', '<<', '::', '->'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Declare an int x = 10 and print it using cout.', language: 'cpp', starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '', expected_output: '10' }] }
    ]
  }),
  lesson(5, 'Variables', 6, {
    explanation: 'A C++ variable is a named, typed storage location, declared before use — the same static-typing model as C, since C++ is a superset of C in this respect.',
    syntax: 'type variable_name = value;',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    int age = 20;\n    cout << age;\n    return 0;\n}', output: '20' }],
    important_points: ['C++ variable names are case-sensitive.', 'C++11 onward also allows `auto` to infer a variable\'s type from its initializer.'],
    common_mistakes: ['Declaring a variable but never initializing it, then reading garbage data.'],
    real_world: 'Explicit types let the compiler catch entire classes of bugs before the program ever runs.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int age = 20;\n    cout << age;\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which of these is a valid C++ variable name?', options: ['int 2total;', 'int total_2;', 'int total-2;', 'int class;'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Declare an int named city_code, set it to 500, and print it.', language: 'cpp', starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '', expected_output: '500' }] }
    ]
  }),
  lesson(6, 'Data Types', 6, {
    explanation: 'C++\'s built-in types include int, float, double, char, bool, and (via the STL) string. bool is a true first-class type in C++, unlike plain C.',
    syntax: 'int, float, double, char, bool, string',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    cout << sizeof(int) << " " << sizeof(double) << " " << sizeof(bool);\n    return 0;\n}', output: '4 8 1' }],
    important_points: ['bool holds true or false directly, not 0/1 tricks.', 'std::string (from <string>) is easier to work with than raw char arrays.'],
    common_mistakes: ['Using a raw char array where std::string would be simpler and safer.'],
    real_world: 'Using bool for flags (isActive, hasSubmitted) instead of int makes intent obvious to anyone reading the code.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    cout << sizeof(int) << " " << sizeof(double) << " " << sizeof(bool);\n    return 0;\n}\n' }, stubTest('Data Types')),
  lesson(7, 'Input and Output', 6, {
    explanation: 'cin reads input and cout writes output, both using the stream operators >> and <<. Multiple values can be chained in a single statement.',
    syntax: 'cin >> variable;',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    int n;\n    cin >> n;\n    cout << "You entered " << n;\n    return 0;\n}', output: '(reads a number)\nYou entered <n>' }],
    important_points: ['>> points "into" the variable being read; << points "out to" the destination being printed.', 'cin >> a >> b; reads two values in one line.'],
    common_mistakes: ['Mixing up the direction of >> and <<.'],
    real_world: 'Interactive console tools and competitive-programming solutions read input this way almost universally.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int n;\n    cin >> n;\n    cout << "You entered " << n;\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which operator is used to read input into a variable with cin?', options: ['<<', '>>', '::', '->'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an integer n and print its double (n * 2).', language: 'cpp', starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int n;\n    cin >> n;\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '4', expected_output: '8' }, { input: '10', expected_output: '20' }] }
    ]
  }),
  lesson(8, 'Type Casting', 5, {
    explanation: 'C++ allows implicit casts (in mixed-type expressions) and explicit casts using either C-style (type)value or C++-style static_cast<type>(value), the latter being preferred for clarity and safety.',
    syntax: 'static_cast<type>(value)',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    double d = static_cast<double>(7) / 2;\n    cout << d;\n    return 0;\n}', output: '3.5' }],
    important_points: ['static_cast<> is checked at compile time and is safer than a raw C-style cast.', 'Integer division still truncates unless a cast forces a floating-point result.'],
    common_mistakes: ['Dividing two ints and expecting a decimal without casting one operand first.'],
    real_world: 'static_cast is the standard, safe way modern C++ codebases convert between numeric types.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    double d = static_cast<double>(7) / 2;\n    cout << d;\n    return 0;\n}\n' }, stubTest('Type Casting')),
  lesson(9, 'Operators', 6, {
    explanation: 'C++ inherits C\'s full operator set — arithmetic, relational, logical, assignment — and adds a few of its own, like the stream operators << >> and the scope resolution operator ::.',
    syntax: 'a + b, a % b',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    cout << 7 / 2 << " " << 7 % 2;\n    return 0;\n}', output: '3 1' }],
    important_points: ['/ between two ints truncates (integer division).', '&& and || are logical operators, distinct from the bitwise & and |.'],
    common_mistakes: ['Using = (assignment) where == (comparison) was intended inside an if condition.'],
    real_world: 'This exact operator set is what powers loop conditions and calculations across essentially every C++ program.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    cout << 7 / 2 << " " << 7 % 2;\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'output', text: 'What does `cout << 10 % 3;` output?', options: ['3', '1', '3.33', '0'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read two integers a and b and print their sum.', language: 'cpp', starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int a, b;\n    cin >> a >> b;\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '2\n3', expected_output: '5' }, { input: '10\n20', expected_output: '30' }] }
    ]
  }),
  lesson(10, 'Comments', 4, {
    explanation: 'Comments are ignored by the compiler and document intent. Use // for a single line or /* ... */ for a block — identical syntax to C.',
    syntax: '// single line\n/* multi\n   line */',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    // prints a greeting\n    cout << "Hi";\n    return 0;\n}', output: 'Hi' }],
    important_points: ['Good comments explain WHY, not just restate the code.', 'Block comments cannot be nested in standard C++.'],
    common_mistakes: ['Leaving stale comments that no longer match what the code actually does.'],
    real_world: 'Large C++ codebases (game engines, browsers) rely on consistent commenting conventions across huge teams.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    // prints a greeting\n    cout << "Hi";\n    return 0;\n}\n' }, stubTest('Comments'))
];

const JAVA_MODULE1_LESSONS = [
  lesson(1, 'Introduction to Java', 6, {
    explanation: 'Java is a compiled, object-oriented language that runs on the Java Virtual Machine (JVM), which is why it\'s described as "write once, run anywhere" — the same compiled bytecode runs unmodified on any platform with a JVM.',
    syntax: '',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}', output: 'Hello, World!' }],
    important_points: ['Every Java file\'s public class name must match the file name.', 'Java code compiles to bytecode, then runs on the JVM — not directly to machine code.', 'Java is strictly object-oriented: even main() lives inside a class.'],
    common_mistakes: ['Forgetting the semicolon after a statement.', 'Naming the file differently from its public class.'],
    real_world: 'Android apps, large enterprise banking systems, and most university teaching languages are built on Java\'s "write once, run anywhere" model.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'What does Java code compile to before running on the JVM?', options: ['Machine code directly', 'Bytecode', 'Assembly', 'Plain text'], correct_index: 1 },
      { id: qid('q'), type: 'truefalse', text: 'A Java file\'s public class name must match the file name.', correct_index: 0, options: ['True', 'False'] },
      { id: qid('q'), type: 'code', text: 'Write a Java program that prints exactly: Hello, Campus Orbis!', language: 'java', starter_code: 'public class Main {\n    public static void main(String[] args) {\n        // write your code here\n    }\n}\n', test_cases: [{ input: '', expected_output: 'Hello, Campus Orbis!' }] }
    ]
  }),
  lesson(2, 'Java Features', 5, {
    explanation: 'Java is platform-independent (via the JVM), strictly object-oriented, automatically manages memory through garbage collection, and has a huge standard library plus a massive open-source ecosystem.',
    syntax: '',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println(Runtime.version());\n    }\n}', output: '<JVM version>' }],
    important_points: ['Automatic garbage collection — you don\'t manually free memory like in C.', 'Strongly, statically typed.', 'Huge ecosystem: Spring, Android SDK, and countless libraries.'],
    common_mistakes: ['Assuming Java has no memory management at all, rather than automatic (garbage-collected) management.'],
    real_world: 'Most Android apps are written in Java (or Kotlin, which also runs on the JVM).'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Java features demo");\n    }\n}\n' }, stubTest('Java Features')),
  lesson(3, 'Installing / Running Java', 5, {
    explanation: 'A Java source file (.java) is compiled with javac into .class bytecode, then run with java. Campus Orbis\'s built-in compiler handles both steps instantly — no local JDK install needed.',
    syntax: 'javac Main.java && java Main',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println(1 + 1);\n    }\n}', output: '2' }],
    important_points: ['.java is the source file extension; .class is the compiled bytecode.', 'The JDK (Java Development Kit) includes both javac and java.'],
    common_mistakes: ['Trying to run a .java file directly without compiling it first.'],
    real_world: 'Every Java build tool (Maven, Gradle) is automating exactly this compile-then-run sequence under the hood.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println(1 + 1);\n    }\n}\n' }, stubTest('Installing / Running Java')),
  lesson(4, 'Structure of a Java Program', 6, {
    explanation: 'Every Java program has at least one class, and execution starts at the special `public static void main(String[] args)` method inside that class — the JVM looks for exactly this signature to begin running.',
    syntax: 'public class ClassName {\n    public static void main(String[] args) {\n        // statements\n    }\n}',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        int x = 5;\n        System.out.println("x = " + x);\n    }\n}', output: 'x = 5' }],
    important_points: ['`public static void main(String[] args)` must be spelled exactly this way for Java to find it.', 'The + operator concatenates a String with other values automatically.'],
    common_mistakes: ['Misspelling "main" or getting the signature slightly wrong, so the JVM can\'t find an entry point.'],
    real_world: 'Every standalone Java application, no matter how large, still boots from this exact same main() entry point.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        int x = 5;\n        System.out.println("x = " + x);\n    }\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which method does the JVM look for to start running a Java program?', options: ['start()', 'run()', 'main(String[] args)', 'init()'], correct_index: 2 },
      { id: qid('q'), type: 'code', text: 'Declare an int x = 10 and print it.', language: 'java', starter_code: 'public class Main {\n    public static void main(String[] args) {\n        // write your code here\n    }\n}\n', test_cases: [{ input: '', expected_output: '10' }] }
    ]
  }),
  lesson(5, 'Variables', 6, {
    explanation: 'A Java variable is a named, typed storage location. Java is statically typed like C/C++ — the type is declared once and can never change.',
    syntax: 'type variableName = value;',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        int age = 20;\n        System.out.println(age);\n    }\n}', output: '20' }],
    important_points: ['Java conventionally uses camelCase for variable names (studentAge, not student_age).', 'Variable names are case-sensitive.'],
    common_mistakes: ['Declaring a variable without initializing it, then trying to use it (Java won\'t compile this — unlike C).'],
    real_world: 'Explicit types are why Java IDEs can autocomplete and catch type errors before you even run the code.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        int age = 20;\n        System.out.println(age);\n    }\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which of these follows standard Java variable naming convention?', options: ['student_age', 'StudentAge', 'studentAge', '2studentAge'], correct_index: 2 },
      { id: qid('q'), type: 'code', text: 'Declare an int cityCode = 500 and print it.', language: 'java', starter_code: 'public class Main {\n    public static void main(String[] args) {\n        // write your code here\n    }\n}\n', test_cases: [{ input: '', expected_output: '500' }] }
    ]
  }),
  lesson(6, 'Data Types', 6, {
    explanation: 'Java has 8 primitive types: byte, short, int, long (whole numbers), float, double (decimals), char (a character), and boolean (true/false). Everything else (String, arrays, objects) is a reference type.',
    syntax: 'int, double, char, boolean, String',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        int a = 10;\n        double b = 3.14;\n        boolean c = true;\n        System.out.println(a + " " + b + " " + c);\n    }\n}', output: '10 3.14 true' }],
    important_points: ['String is not a primitive — it\'s an object, but usable much like a primitive in practice.', 'boolean can only be true or false, never 0/1 like in C.'],
    common_mistakes: ['Comparing two Strings with == (compares references) instead of .equals() (compares content).'],
    real_world: 'Getting == vs .equals() wrong on Strings is one of the most common real bugs new Java developers hit.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        int a = 10;\n        double b = 3.14;\n        boolean c = true;\n        System.out.println(a + " " + b + " " + c);\n    }\n}\n' }, stubTest('Data Types')),
  lesson(7, 'Input and Output', 6, {
    explanation: 'System.out.println() prints output. Reading input typically uses a Scanner object from java.util.Scanner, which can read ints, doubles, and full lines.',
    syntax: 'Scanner sc = new Scanner(System.in);\nint n = sc.nextInt();',
    examples: [{ code: 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int n = sc.nextInt();\n        System.out.println("You entered " + n);\n    }\n}', output: '(reads a number)\nYou entered <n>' }],
    important_points: ['Scanner needs `import java.util.Scanner;` at the top of the file.', 'sc.nextInt() reads an int; sc.nextLine() reads a full line of text.'],
    common_mistakes: ['Mixing nextInt() and nextLine() calls without accounting for the leftover newline character.'],
    real_world: 'Any interactive Java console program — from a grading tool to a simple menu system — reads input through Scanner exactly like this.'
  }, { starter_code: 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int n = sc.nextInt();\n        System.out.println("You entered " + n);\n    }\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which class is commonly used to read console input in Java?', options: ['Reader', 'Scanner', 'InputStream', 'BufferedWriter'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an integer n and print its double (n * 2).', language: 'java', starter_code: 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int n = sc.nextInt();\n        // write your code here\n    }\n}\n', test_cases: [{ input: '4', expected_output: '8' }, { input: '10', expected_output: '20' }] }
    ]
  }),
  lesson(8, 'Type Casting', 5, {
    explanation: 'Java supports implicit widening casts (int to double happens automatically) and explicit narrowing casts using (type)value, which are required when converting to a smaller/less precise type.',
    syntax: '(type) value',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        double d = (double) 7 / 2;\n        System.out.println(d);\n    }\n}', output: '3.5' }],
    important_points: ['Widening (int → double) happens automatically; narrowing (double → int) must be explicit.', 'Casting double to int truncates the decimal part, it does not round.'],
    common_mistakes: ['Dividing two ints and expecting a decimal without casting one operand to double first.'],
    real_world: 'Averaging integer test scores into a decimal GPA requires exactly this kind of explicit cast.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        double d = (double) 7 / 2;\n        System.out.println(d);\n    }\n}\n' }, stubTest('Type Casting')),
  lesson(9, 'Operators', 6, {
    explanation: 'Java\'s operators mirror C/C++: arithmetic (+ - * / %), relational (== != < > <= >=), logical (&& || !), and assignment (= += -= ...).',
    syntax: 'a + b, a % b',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println((7 / 2) + " " + (7 % 2));\n    }\n}', output: '3 1' }],
    important_points: ['/ between two ints performs integer (truncating) division.', 'Use .equals() rather than == to compare the CONTENT of two String objects.'],
    common_mistakes: ['Using == to compare Strings and getting unexpected results depending on how they were created.'],
    real_world: 'This operator set drives essentially every calculation and condition in every Java program you\'ll write.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println((7 / 2) + " " + (7 % 2));\n    }\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'output', text: 'What does `System.out.println(10 % 3);` output?', options: ['3', '1', '3.33', '0'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read two integers a and b and print their sum.', language: 'java', starter_code: 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int a = sc.nextInt();\n        int b = sc.nextInt();\n        // write your code here\n    }\n}\n', test_cases: [{ input: '2\n3', expected_output: '5' }, { input: '10\n20', expected_output: '30' }] }
    ]
  }),
  lesson(10, 'Comments', 4, {
    explanation: 'Comments are ignored by the compiler. Use // for a single line, /* ... */ for a block, and /** ... */ (Javadoc) to document classes and methods for auto-generated documentation.',
    syntax: '// single line\n/* multi\n   line */\n/** Javadoc */',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        // prints a greeting\n        System.out.println("Hi");\n    }\n}', output: 'Hi' }],
    important_points: ['Javadoc comments (/** */) can auto-generate HTML documentation for a whole project.', 'Good comments explain WHY, not just restate the code.'],
    common_mistakes: ['Never using Javadoc on public methods in a library, making them hard for others to use correctly.'],
    real_world: 'Every major Java library (like the JDK itself) ships with Javadoc-generated documentation you\'ve probably already used.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        // prints a greeting\n        System.out.println("Hi");\n    }\n}\n' }, stubTest('Comments'))
];

const JS_MODULE1_LESSONS = [
  lesson(1, 'Introduction to JavaScript', 6, {
    explanation: 'JavaScript is an interpreted, dynamically typed language that runs in web browsers and (via Node.js) on servers. It\'s the language that makes web pages interactive.',
    syntax: '',
    examples: [{ code: 'console.log("Hello, World!");', output: 'Hello, World!' }],
    important_points: ['JavaScript is interpreted — no separate compile step before running.', 'JavaScript is dynamically typed — a variable\'s type can change at runtime.', 'JavaScript runs both in the browser and on servers (Node.js).'],
    common_mistakes: ['Confusing JavaScript with Java — they are unrelated languages that only share part of a name.'],
    real_world: 'Every interactive website — from a "like" button to a full web app like Gmail — runs on JavaScript in the browser.'
  }, { starter_code: 'console.log("Hello, World!");\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'JavaScript is best described as which type of language?', options: ['Compiled only', 'Interpreted, dynamically typed', 'Markup language', 'Query language'], correct_index: 1 },
      { id: qid('q'), type: 'truefalse', text: 'JavaScript and Java are the same language.', correct_index: 1, options: ['True', 'False'] },
      { id: qid('q'), type: 'code', text: 'Write a JavaScript program that prints exactly: Hello, Campus Orbis!', language: 'javascript', starter_code: '// write your code here\n', test_cases: [{ input: '', expected_output: 'Hello, Campus Orbis!' }] }
    ]
  }),
  lesson(2, 'JS Features', 5, {
    explanation: 'JavaScript supports multiple programming styles (procedural, object-oriented, functional), has first-class functions (functions can be passed around like values), and is single-threaded with an event loop for handling asynchronous work.',
    syntax: '',
    examples: [{ code: 'console.log(typeof "hello");', output: 'string' }],
    important_points: ['Functions are "first-class" — they can be stored in variables and passed as arguments.', 'JavaScript has a single-threaded event loop, not true multi-threading.', 'JSON (JavaScript Object Notation) is native to JS and used everywhere for data exchange.'],
    common_mistakes: ['Assuming JavaScript blocks on slow operations the way many other languages do — it typically doesn\'t, by design.'],
    real_world: 'Almost every API you\'ll ever call from a website returns JSON, JavaScript\'s native data format.'
  }, { starter_code: 'console.log(typeof "hello");\n' }, stubTest('JS Features')),
  lesson(3, 'Running JavaScript', 5, {
    explanation: 'JavaScript runs directly in a browser\'s developer console, inside a <script> tag in an HTML page, or on a server via Node.js — no separate compile step is needed. Campus Orbis\'s built-in compiler runs it instantly.',
    syntax: 'node filename.js',
    examples: [{ code: 'console.log(1 + 1);', output: '2' }],
    important_points: ['.js is the standard JavaScript source file extension.', 'Node.js lets JavaScript run outside the browser, e.g. as a backend server.'],
    common_mistakes: ['Assuming a browser and Node.js always provide the exact same built-in objects (they don\'t — e.g. no `window` in Node).'],
    real_world: 'Full-stack "MERN"/"MEAN" web apps use JavaScript for both the browser frontend and the Node.js backend.'
  }, { starter_code: 'console.log(1 + 1);\n' }, stubTest('Running JavaScript')),
  lesson(4, 'Variables (var/let/const)', 6, {
    explanation: 'JavaScript has three ways to declare a variable: `var` (old, function-scoped), `let` (modern, block-scoped, reassignable), and `const` (modern, block-scoped, cannot be reassigned). Modern code prefers let/const.',
    syntax: 'let name = value;\nconst name = value;',
    examples: [{ code: 'let age = 20;\nconst name = "Ravi";\nconsole.log(name, age);', output: 'Ravi 20' }],
    important_points: ['const doesn\'t make an object\'s contents immutable — only the variable binding itself.', 'let is scoped to the nearest { } block; var is not.', 'Prefer const by default, and let only when you truly need to reassign.'],
    common_mistakes: ['Using var out of habit and running into confusing scoping bugs that let/const avoid.'],
    real_world: 'Modern JavaScript style guides (used at almost every company) require let/const and forbid var.'
  }, { starter_code: 'let age = 20;\nconst name = "Ravi";\nconsole.log(name, age);\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which keyword declares a variable that cannot be reassigned?', options: ['var', 'let', 'const', 'static'], correct_index: 2 },
      { id: qid('q'), type: 'code', text: 'Declare a const named city with the value "Hyderabad" and print it.', language: 'javascript', starter_code: '// write your code here\n', test_cases: [{ input: '', expected_output: 'Hyderabad' }] }
    ]
  }),
  lesson(5, 'Data Types', 6, {
    explanation: 'JavaScript has primitive types: number (both ints and decimals), string, boolean, undefined, null, and (ES2020+) bigint/symbol. Objects and arrays are reference types. Use typeof to check a value\'s type.',
    syntax: 'typeof value',
    examples: [{ code: 'console.log(typeof 10, typeof "hi", typeof true, typeof undefined);', output: 'number string boolean undefined' }],
    important_points: ['There is only one numeric type, `number`, for both integers and decimals.', 'undefined means a variable was declared but never assigned; null means "intentionally no value".'],
    common_mistakes: ['Confusing undefined and null — they are different values with different meanings.'],
    real_world: 'API responses often use null to explicitly mean "no data", distinct from a field that\'s simply undefined/missing.'
  }, { starter_code: 'console.log(typeof 10, typeof "hi", typeof true, typeof undefined);\n' }, stubTest('Data Types')),
  lesson(6, 'Input and Output (console)', 6, {
    explanation: 'console.log() is JavaScript\'s primary way to print output for debugging. In this course\'s compiler, input is read as pre-provided lines (like a real program\'s stdin), matching how the other course languages read input too.',
    syntax: 'console.log(value);',
    examples: [{ code: 'console.log("Hello", "Campus Orbis");', output: 'Hello Campus Orbis' }],
    important_points: ['console.log() can print multiple, comma-separated values at once, space-separated.', 'console.error() and console.warn() exist for other message levels.'],
    common_mistakes: ['Leaving debug console.log() calls in production code.'],
    real_world: 'Every JavaScript developer uses console.log() constantly while debugging, in the browser and in Node.js alike.'
  }, { starter_code: 'console.log("Hello", "Campus Orbis");\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which function is JavaScript\'s primary way to print output?', options: ['print()', 'echo()', 'console.log()', 'System.out()'], correct_index: 2 },
      { id: qid('q'), type: 'code', text: 'Print the numbers 1 and 2 on the same line, separated by a space.', language: 'javascript', starter_code: '// write your code here\n', test_cases: [{ input: '', expected_output: '1 2' }] }
    ]
  }),
  lesson(7, 'Type Conversion', 5, {
    explanation: 'JavaScript converts types implicitly in many expressions ("coercion"), which can be surprising — e.g. "5" + 1 gives "51", not 6. Explicit conversion uses Number(), String(), or Boolean().',
    syntax: 'Number(value), String(value), Boolean(value)',
    examples: [{ code: 'console.log("5" + 1);\nconsole.log(Number("5") + 1);', output: '51\n6' }],
    important_points: ['+ concatenates when either side is a string; it only adds numerically when both sides are numbers.', 'Number("abc") returns NaN (Not a Number), not an error.'],
    common_mistakes: ['Adding a string and a number and expecting numeric addition, instead of string concatenation.'],
    real_world: 'Values read from an HTML form are always strings — this exact conversion is needed before doing math with them.'
  }, { starter_code: 'console.log("5" + 1);\nconsole.log(Number("5") + 1);\n' }, stubTest('Type Conversion')),
  lesson(8, 'Operators', 6, {
    explanation: 'JavaScript has arithmetic (+ - * / % **), comparison (== != < > <= >=, plus strict === !==), logical (&& || !), and assignment (= += -= ...) operators. Prefer === over == to avoid type-coercion surprises.',
    syntax: 'a + b, a % b, a === b',
    examples: [{ code: 'console.log(7 % 2);\nconsole.log("5" == 5);\nconsole.log("5" === 5);', output: '1\ntrue\nfalse' }],
    important_points: ['== compares values after converting types; === compares both value and type, with no conversion.', '** is the exponentiation operator.'],
    common_mistakes: ['Using == instead of === and getting an unexpected true from type coercion.'],
    real_world: 'Linters at most companies actually forbid == entirely, requiring === everywhere for exactly this reason.'
  }, { starter_code: 'console.log(7 % 2);\nconsole.log("5" == 5);\nconsole.log("5" === 5);\n' }, {
    questions: [
      { id: qid('q'), type: 'output', text: 'What does `console.log("5" === 5);` output?', options: ['true', 'false', 'undefined', 'Error'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read two integers a and b (one per line) and print their sum.', language: 'javascript', starter_code: '// write your code here\n', test_cases: [{ input: '2\n3', expected_output: '5' }, { input: '10\n20', expected_output: '30' }] }
    ]
  }),
  lesson(9, 'Comments', 4, {
    explanation: 'Comments are ignored by the JavaScript engine. Use // for a single line or /* ... */ for a block spanning multiple lines.',
    syntax: '// single line\n/* multi\n   line */',
    examples: [{ code: '// prints a greeting\nconsole.log("Hi");', output: 'Hi' }],
    important_points: ['Comments should explain WHY, not just restate WHAT the code does.', 'JSDoc-style comments (/** */) can document function parameters and return types for tooling.'],
    common_mistakes: ['Leaving an unclosed /* comment, which silently comments out the rest of the file.'],
    real_world: 'JSDoc comments power autocomplete and inline documentation in editors like VS Code, even for plain JavaScript.'
  }, { starter_code: '// prints a greeting\nconsole.log("Hi");\n' }, stubTest('Comments'))
];

// ---------------------------------------------------------------------------
// Module 2 — Control Flow (fully authored) — C, C++, Java, JavaScript.
// Same authoring depth/format as Module 1 above; wired in via
// buildStubCourse's moduleOverrides map below. Modules 3-15 remain stubs.
// ---------------------------------------------------------------------------
const C_MODULE2_LESSONS = [
  lesson(1, 'if Statement', 5, {
    explanation: 'The if statement runs a block of code only when its condition evaluates to true (non-zero in C). Any non-zero value is treated as true; 0 is treated as false.',
    syntax: 'if (condition) {\n    // statements\n}',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    int age = 20;\n    if (age >= 18) {\n        printf("Adult");\n    }\n    return 0;\n}', output: 'Adult' }],
    important_points: ['C has no true/false type for conditions — any non-zero number counts as true.', 'Braces {} are optional for a single statement, but recommended for clarity.'],
    common_mistakes: ['Using = (assignment) instead of == (comparison) inside the condition — a classic C bug that silently compiles.'],
    real_world: 'Eligibility checks (age, marks, balance) in almost any program start with an if statement like this.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    int age = 20;\n    if (age >= 18) {\n        printf("Adult");\n    }\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'In C, which value is treated as false in a condition?', options: ['-1', '0', '1', 'Any negative number'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an integer n. Print "Positive" if n > 0.', language: 'c', starter_code: '#include <stdio.h>\nint main() {\n    int n;\n    scanf("%d", &n);\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '5', expected_output: 'Positive' }, { input: '-3', expected_output: '' }] }
    ]
  }),
  lesson(2, 'if-else', 5, {
    explanation: 'if-else lets you run one block when the condition is true and a different block when it is false, covering both outcomes with one statement.',
    syntax: 'if (condition) {\n    // true branch\n} else {\n    // false branch\n}',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    int age = 15;\n    if (age >= 18) printf("Adult");\n    else printf("Minor");\n    return 0;\n}', output: 'Minor' }],
    important_points: ['Exactly one of the two branches runs, never both, never neither.', 'The else always pairs with the nearest unmatched if.'],
    common_mistakes: ['Adding a semicolon right after if(condition); — this makes the if body empty and the real statement always runs.'],
    real_world: 'Pass/fail grading, login success/failure — any two-outcome decision uses if-else.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    int age = 15;\n    if (age >= 18) printf("Adult");\n    else printf("Minor");\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'code', text: 'Read an integer n. Print "Even" if divisible by 2, else "Odd".', language: 'c', starter_code: '#include <stdio.h>\nint main() {\n    int n;\n    scanf("%d", &n);\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '4', expected_output: 'Even' }, { input: '7', expected_output: 'Odd' }] }
    ]
  }),
  lesson(3, 'else if', 5, {
    explanation: 'else if chains multiple conditions in order, checking each only if the previous ones were false — used when there are more than two possible outcomes.',
    syntax: 'if (c1) { }\nelse if (c2) { }\nelse { }',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    int marks = 75;\n    if (marks >= 90) printf("A");\n    else if (marks >= 75) printf("B");\n    else printf("C");\n    return 0;\n}', output: 'B' }],
    important_points: ['Conditions are checked top to bottom; the first true one wins and the rest are skipped.', 'The final else (if present) catches everything not matched above.'],
    common_mistakes: ['Writing overlapping conditions in the wrong order, so an earlier one always catches cases meant for a later one.'],
    real_world: 'Grade calculators and tax-slab calculators are classic else-if chains.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    int marks = 75;\n    if (marks >= 90) printf("A");\n    else if (marks >= 75) printf("B");\n    else printf("C");\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'code', text: 'Read marks (int). Print "A" if >=90, "B" if >=75, else "C".', language: 'c', starter_code: '#include <stdio.h>\nint main() {\n    int marks;\n    scanf("%d", &marks);\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '95', expected_output: 'A' }, { input: '80', expected_output: 'B' }, { input: '50', expected_output: 'C' }] }
    ]
  }),
  lesson(4, 'Nested Conditions', 5, {
    explanation: 'An if/else can contain another if/else inside it, letting you check a second condition only after the first is already true — useful when a decision depends on more than one factor together.',
    syntax: 'if (c1) {\n    if (c2) { }\n}',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    int age = 20, hasId = 1;\n    if (age >= 18) {\n        if (hasId) printf("Entry allowed");\n        else printf("ID required");\n    } else {\n        printf("Too young");\n    }\n    return 0;\n}', output: 'Entry allowed' }],
    important_points: ['Deep nesting hurts readability — often an && in a single if is clearer.', 'Indentation matters for humans reading nested blocks, even though C ignores whitespace.'],
    common_mistakes: ['Losing track of which else belongs to which if in deeply nested code.'],
    real_world: 'Loan approval systems often nest: check income, then within that check credit score, then within that check existing debt.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    int age = 20, hasId = 1;\n    if (age >= 18) {\n        if (hasId) printf("Entry allowed");\n        else printf("ID required");\n    } else {\n        printf("Too young");\n    }\n    return 0;\n}\n' }, stubTest('Nested Conditions')),
  lesson(5, 'switch', 5, {
    explanation: 'switch compares one value against several possible constant cases, running the matching case\'s code — often clearer than a long else-if chain when checking one variable against many fixed values.',
    syntax: 'switch (value) {\n    case 1: ...; break;\n    default: ...;\n}',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    int day = 3;\n    switch (day) {\n        case 1: printf("Mon"); break;\n        case 2: printf("Tue"); break;\n        case 3: printf("Wed"); break;\n        default: printf("Other");\n    }\n    return 0;\n}', output: 'Wed' }],
    important_points: ['Without break, execution "falls through" into the next case — sometimes intentional, usually a bug.', 'default handles any value not matched by a case, similar to a final else.'],
    common_mistakes: ['Forgetting break; at the end of a case, causing unintended fall-through into the next case.'],
    real_world: 'Menu-driven console programs (1=Add, 2=Delete, 3=Exit) are a textbook switch use case.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    int day = 3;\n    switch (day) {\n        case 1: printf("Mon"); break;\n        case 2: printf("Tue"); break;\n        case 3: printf("Wed"); break;\n        default: printf("Other");\n    }\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'What happens if you forget `break;` in a switch case?', options: ['Compile error', 'Execution falls through to the next case', 'Nothing runs', 'Only default runs'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an int 1-3 and print "One"/"Two"/"Three" using switch; print "Invalid" otherwise.', language: 'c', starter_code: '#include <stdio.h>\nint main() {\n    int n;\n    scanf("%d", &n);\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '2', expected_output: 'Two' }, { input: '9', expected_output: 'Invalid' }] }
    ]
  }),
  lesson(6, 'for Loop', 6, {
    explanation: 'A for loop repeats code a known number of times, combining initialization, condition, and increment in one line — the standard choice when you know in advance how many iterations you need.',
    syntax: 'for (init; condition; update) {\n    // body\n}',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    for (int i = 1; i <= 5; i++) {\n        printf("%d ", i);\n    }\n    return 0;\n}', output: '1 2 3 4 5 ' }],
    important_points: ['The loop runs while the condition is true, checked before every iteration.', 'All three parts (init, condition, update) are optional but the semicolons are required.'],
    common_mistakes: ['Off-by-one errors: using <= vs < incorrectly, running one iteration too many or too few.'],
    real_world: 'Printing a multiplication table or processing every element of a fixed-size array both use for loops.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    for (int i = 1; i <= 5; i++) {\n        printf("%d ", i);\n    }\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'output', text: 'What does this print?\nfor (int i = 0; i < 3; i++) printf("%d", i);', options: ['123', '012', '0123', '1 2 3'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an integer n and print the sum of 1 to n using a for loop.', language: 'c', starter_code: '#include <stdio.h>\nint main() {\n    int n;\n    scanf("%d", &n);\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '5', expected_output: '15' }, { input: '10', expected_output: '55' }] }
    ]
  }),
  lesson(7, 'while Loop', 5, {
    explanation: 'A while loop repeats code as long as its condition stays true, checked before each iteration — used when the number of repetitions isn\'t known in advance.',
    syntax: 'while (condition) {\n    // body\n}',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    int i = 1;\n    while (i <= 5) {\n        printf("%d ", i);\n        i++;\n    }\n    return 0;\n}', output: '1 2 3 4 5 ' }],
    important_points: ['You must update the loop variable yourself inside the loop, or it runs forever.', 'The condition is checked BEFORE the body — if false at the start, the body never runs at all.'],
    common_mistakes: ['Forgetting to update the loop variable, causing an infinite loop.'],
    real_world: 'Reading input until a sentinel value (like -1) appears is a classic while-loop pattern.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    int i = 1;\n    while (i <= 5) {\n        printf("%d ", i);\n        i++;\n    }\n    return 0;\n}\n' }, stubTest('while Loop')),
  lesson(8, 'do-while Loop', 5, {
    explanation: 'A do-while loop runs its body once BEFORE checking the condition, guaranteeing at least one execution — the key difference from a regular while loop.',
    syntax: 'do {\n    // body\n} while (condition);',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    int i = 1;\n    do {\n        printf("%d ", i);\n        i++;\n    } while (i <= 5);\n    return 0;\n}', output: '1 2 3 4 5 ' }],
    important_points: ['The body always runs at least once, even if the condition is false from the start.', 'Note the required semicolon after while(condition);.'],
    common_mistakes: ['Forgetting the trailing semicolon after the while(condition) in a do-while.'],
    real_world: 'A "menu, then ask to repeat?" loop in a console app is naturally a do-while — show the menu at least once.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    int i = 1;\n    do {\n        printf("%d ", i);\n        i++;\n    } while (i <= 5);\n    return 0;\n}\n' }, stubTest('do-while Loop')),
  lesson(9, 'break', 4, {
    explanation: 'break immediately exits the nearest enclosing loop (or switch), skipping any remaining iterations.',
    syntax: 'break;',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    for (int i = 1; i <= 10; i++) {\n        if (i == 5) break;\n        printf("%d ", i);\n    }\n    return 0;\n}', output: '1 2 3 4 ' }],
    important_points: ['break exits only the SINGLE closest loop, not all nested loops at once.', 'Commonly used to stop searching once a match is found.'],
    common_mistakes: ['Expecting break to exit multiple nested loops at once — it only exits the innermost one.'],
    real_world: 'Searching a list and stopping as soon as the target is found uses break to avoid needless extra iterations.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    for (int i = 1; i <= 10; i++) {\n        if (i == 5) break;\n        printf("%d ", i);\n    }\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'code', text: 'Print numbers 1 to 10, but stop (break) as soon as you reach a number greater than 6.', language: 'c', starter_code: '#include <stdio.h>\nint main() {\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '', expected_output: '1 2 3 4 5 6 ' }] }
    ]
  }),
  lesson(10, 'continue', 4, {
    explanation: 'continue skips the rest of the current iteration and jumps straight to the loop\'s next check/update, without exiting the loop entirely.',
    syntax: 'continue;',
    examples: [{ code: '#include <stdio.h>\nint main() {\n    for (int i = 1; i <= 5; i++) {\n        if (i == 3) continue;\n        printf("%d ", i);\n    }\n    return 0;\n}', output: '1 2 4 5 ' }],
    important_points: ['continue skips only the current iteration, unlike break which exits the whole loop.', 'In a for loop, the update step (like i++) still runs after continue.'],
    common_mistakes: ['Confusing continue (skip this iteration) with break (exit the loop entirely).'],
    real_world: 'Skipping invalid/blank rows while processing a file line by line is a natural use of continue.'
  }, { starter_code: '#include <stdio.h>\nint main() {\n    for (int i = 1; i <= 5; i++) {\n        if (i == 3) continue;\n        printf("%d ", i);\n    }\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'code', text: 'Print numbers 1 to 6, skipping (continue) any even number.', language: 'c', starter_code: '#include <stdio.h>\nint main() {\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '', expected_output: '1 3 5 ' }] }
    ]
  })
];

const CPP_MODULE2_LESSONS = [
  lesson(1, 'if Statement', 5, {
    explanation: 'The if statement runs a block of code only when its condition is true. C++ has a real bool type (true/false), unlike plain C\'s "any non-zero is true" convention, though both still work.',
    syntax: 'if (condition) {\n    // statements\n}',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    int age = 20;\n    if (age >= 18) {\n        cout << "Adult";\n    }\n    return 0;\n}', output: 'Adult' }],
    important_points: ['C++ has a proper bool type, but conditions still accept any expression that evaluates to zero/non-zero.', 'Braces {} are optional for a single statement but recommended for clarity.'],
    common_mistakes: ['Using = (assignment) instead of == (comparison) inside the condition.'],
    real_world: 'Eligibility checks (age, marks, balance) in almost any program start with an if statement like this.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int age = 20;\n    if (age >= 18) {\n        cout << "Adult";\n    }\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which type does C++ provide for true/false values that plain C lacks?', options: ['int', 'bool', 'flag', 'bit'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an integer n. Print "Positive" if n > 0.', language: 'cpp', starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int n;\n    cin >> n;\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '5', expected_output: 'Positive' }, { input: '-3', expected_output: '' }] }
    ]
  }),
  lesson(2, 'if-else', 5, {
    explanation: 'if-else runs one block when the condition is true and a different block when it is false — exactly the same logic as C, using cout instead of printf.',
    syntax: 'if (condition) {\n    // true branch\n} else {\n    // false branch\n}',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    int age = 15;\n    if (age >= 18) cout << "Adult";\n    else cout << "Minor";\n    return 0;\n}', output: 'Minor' }],
    important_points: ['Exactly one branch runs, never both.', 'The else always pairs with the nearest unmatched if.'],
    common_mistakes: ['Adding a stray semicolon right after if(condition); which makes the if body empty.'],
    real_world: 'Pass/fail grading, login success/failure — any two-outcome decision uses if-else.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int age = 15;\n    if (age >= 18) cout << "Adult";\n    else cout << "Minor";\n    return 0;\n}\n' }, {
    questions: [{ id: qid('q'), type: 'code', text: 'Read an integer n. Print "Even" if divisible by 2, else "Odd".', language: 'cpp', starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int n;\n    cin >> n;\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '4', expected_output: 'Even' }, { input: '7', expected_output: 'Odd' }] }]
  }),
  lesson(3, 'else if', 5, {
    explanation: 'else if chains multiple conditions in order, checking each only if the previous ones were false — used when there are more than two possible outcomes.',
    syntax: 'if (c1) { }\nelse if (c2) { }\nelse { }',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    int marks = 75;\n    if (marks >= 90) cout << "A";\n    else if (marks >= 75) cout << "B";\n    else cout << "C";\n    return 0;\n}', output: 'B' }],
    important_points: ['Conditions are checked top to bottom; the first true one wins and the rest are skipped.', 'A trailing else (if present) catches everything unmatched.'],
    common_mistakes: ['Writing overlapping range checks in the wrong order, so an earlier one always catches cases meant for a later one.'],
    real_world: 'Grade calculators and tax-slab calculators are classic else-if chains.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int marks = 75;\n    if (marks >= 90) cout << "A";\n    else if (marks >= 75) cout << "B";\n    else cout << "C";\n    return 0;\n}\n' }, {
    questions: [{ id: qid('q'), type: 'code', text: 'Read marks (int). Print "A" if >=90, "B" if >=75, else "C".', language: 'cpp', starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int marks;\n    cin >> marks;\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '95', expected_output: 'A' }, { input: '80', expected_output: 'B' }, { input: '50', expected_output: 'C' }] }]
  }),
  lesson(4, 'Nested Conditions', 5, {
    explanation: 'An if/else can contain another if/else inside it, letting you check a second condition only after the first is already true — useful when a decision depends on more than one factor together.',
    syntax: 'if (c1) {\n    if (c2) { }\n}',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    int age = 20; bool hasId = true;\n    if (age >= 18) {\n        if (hasId) cout << "Entry allowed";\n        else cout << "ID required";\n    } else {\n        cout << "Too young";\n    }\n    return 0;\n}', output: 'Entry allowed' }],
    important_points: ['Deep nesting hurts readability — often a single if with && is clearer.', 'Indentation helps humans track which else belongs to which if.'],
    common_mistakes: ['Losing track of which else belongs to which if in deeply nested code.'],
    real_world: 'Loan approval systems often nest: check income, then within that check credit score, then within that check existing debt.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int age = 20; bool hasId = true;\n    if (age >= 18) {\n        if (hasId) cout << "Entry allowed";\n        else cout << "ID required";\n    } else {\n        cout << "Too young";\n    }\n    return 0;\n}\n' }, stubTest('Nested Conditions')),
  lesson(5, 'switch', 5, {
    explanation: 'switch compares one value against several possible constant cases, running the matching case\'s code — often clearer than a long else-if chain when checking one variable against many fixed values.',
    syntax: 'switch (value) {\n    case 1: ...; break;\n    default: ...;\n}',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    int day = 3;\n    switch (day) {\n        case 1: cout << "Mon"; break;\n        case 2: cout << "Tue"; break;\n        case 3: cout << "Wed"; break;\n        default: cout << "Other";\n    }\n    return 0;\n}', output: 'Wed' }],
    important_points: ['Without break, execution "falls through" into the next case.', 'default handles any value not matched by a case, similar to a final else.'],
    common_mistakes: ['Forgetting break; at the end of a case, causing unintended fall-through.'],
    real_world: 'Menu-driven console programs (1=Add, 2=Delete, 3=Exit) are a textbook switch use case.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int day = 3;\n    switch (day) {\n        case 1: cout << "Mon"; break;\n        case 2: cout << "Tue"; break;\n        case 3: cout << "Wed"; break;\n        default: cout << "Other";\n    }\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'What happens if you forget `break;` in a switch case?', options: ['Compile error', 'Execution falls through to the next case', 'Nothing runs', 'Only default runs'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an int 1-3 and print "One"/"Two"/"Three" using switch; print "Invalid" otherwise.', language: 'cpp', starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int n;\n    cin >> n;\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '2', expected_output: 'Two' }, { input: '9', expected_output: 'Invalid' }] }
    ]
  }),
  lesson(6, 'for Loop', 6, {
    explanation: 'A for loop repeats code a known number of times, combining initialization, condition, and update in one line — the standard choice when you know in advance how many iterations you need.',
    syntax: 'for (init; condition; update) {\n    // body\n}',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    for (int i = 1; i <= 5; i++) {\n        cout << i << " ";\n    }\n    return 0;\n}', output: '1 2 3 4 5 ' }],
    important_points: ['The loop runs while the condition is true, checked before every iteration.', 'C++11\'s range-based for (for (auto x : container)) is preferred for iterating containers.'],
    common_mistakes: ['Off-by-one errors: using <= vs < incorrectly, running one iteration too many or too few.'],
    real_world: 'Printing a multiplication table or processing every element of a fixed-size array both use for loops.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    for (int i = 1; i <= 5; i++) {\n        cout << i << " ";\n    }\n    return 0;\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'output', text: 'What does this print?\nfor (int i = 0; i < 3; i++) cout << i;', options: ['123', '012', '0123', '1 2 3'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an integer n and print the sum of 1 to n using a for loop.', language: 'cpp', starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int n;\n    cin >> n;\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '5', expected_output: '15' }, { input: '10', expected_output: '55' }] }
    ]
  }),
  lesson(7, 'while Loop', 5, {
    explanation: 'A while loop repeats code as long as its condition stays true, checked before each iteration — used when the number of repetitions isn\'t known in advance.',
    syntax: 'while (condition) {\n    // body\n}',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    int i = 1;\n    while (i <= 5) {\n        cout << i << " ";\n        i++;\n    }\n    return 0;\n}', output: '1 2 3 4 5 ' }],
    important_points: ['You must update the loop variable yourself inside the loop, or it runs forever.', 'The condition is checked BEFORE the body — if false at the start, the body never runs.'],
    common_mistakes: ['Forgetting to update the loop variable, causing an infinite loop.'],
    real_world: 'Reading input until a sentinel value (like -1) appears is a classic while-loop pattern.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int i = 1;\n    while (i <= 5) {\n        cout << i << " ";\n        i++;\n    }\n    return 0;\n}\n' }, stubTest('while Loop')),
  lesson(8, 'do-while Loop', 5, {
    explanation: 'A do-while loop runs its body once BEFORE checking the condition, guaranteeing at least one execution — the key difference from a regular while loop.',
    syntax: 'do {\n    // body\n} while (condition);',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    int i = 1;\n    do {\n        cout << i << " ";\n        i++;\n    } while (i <= 5);\n    return 0;\n}', output: '1 2 3 4 5 ' }],
    important_points: ['The body always runs at least once, even if the condition is false from the start.', 'Note the required semicolon after while(condition);.'],
    common_mistakes: ['Forgetting the trailing semicolon after the while(condition) in a do-while.'],
    real_world: 'A "menu, then ask to repeat?" loop in a console app is naturally a do-while — show the menu at least once.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    int i = 1;\n    do {\n        cout << i << " ";\n        i++;\n    } while (i <= 5);\n    return 0;\n}\n' }, stubTest('do-while Loop')),
  lesson(9, 'break', 4, {
    explanation: 'break immediately exits the nearest enclosing loop (or switch), skipping any remaining iterations.',
    syntax: 'break;',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    for (int i = 1; i <= 10; i++) {\n        if (i == 5) break;\n        cout << i << " ";\n    }\n    return 0;\n}', output: '1 2 3 4 ' }],
    important_points: ['break exits only the single closest loop, not all nested loops at once.', 'Commonly used to stop searching once a match is found.'],
    common_mistakes: ['Expecting break to exit multiple nested loops at once — it only exits the innermost one.'],
    real_world: 'Searching a list and stopping as soon as the target is found uses break to avoid needless extra iterations.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    for (int i = 1; i <= 10; i++) {\n        if (i == 5) break;\n        cout << i << " ";\n    }\n    return 0;\n}\n' }, {
    questions: [{ id: qid('q'), type: 'code', text: 'Print numbers 1 to 10, but stop (break) as soon as you reach a number greater than 6.', language: 'cpp', starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '', expected_output: '1 2 3 4 5 6 ' }] }]
  }),
  lesson(10, 'continue', 4, {
    explanation: 'continue skips the rest of the current iteration and jumps straight to the loop\'s next check/update, without exiting the loop entirely.',
    syntax: 'continue;',
    examples: [{ code: '#include <iostream>\nusing namespace std;\nint main() {\n    for (int i = 1; i <= 5; i++) {\n        if (i == 3) continue;\n        cout << i << " ";\n    }\n    return 0;\n}', output: '1 2 4 5 ' }],
    important_points: ['continue skips only the current iteration, unlike break which exits the whole loop.', 'In a for loop, the update step (like i++) still runs after continue.'],
    common_mistakes: ['Confusing continue (skip this iteration) with break (exit the loop entirely).'],
    real_world: 'Skipping invalid/blank rows while processing a file line by line is a natural use of continue.'
  }, { starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    for (int i = 1; i <= 5; i++) {\n        if (i == 3) continue;\n        cout << i << " ";\n    }\n    return 0;\n}\n' }, {
    questions: [{ id: qid('q'), type: 'code', text: 'Print numbers 1 to 6, skipping (continue) any even number.', language: 'cpp', starter_code: '#include <iostream>\nusing namespace std;\nint main() {\n    // write your code here\n    return 0;\n}\n', test_cases: [{ input: '', expected_output: '1 3 5 ' }] }]
  })
];

const JAVA_MODULE2_LESSONS = [
  lesson(1, 'if Statement', 5, {
    explanation: 'The if statement runs a block of code only when its condition (which must be a boolean) is true. Unlike C, Java requires the condition to genuinely be a boolean — an int can never substitute.',
    syntax: 'if (condition) {\n    // statements\n}',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        int age = 20;\n        if (age >= 18) {\n            System.out.println("Adult");\n        }\n    }\n}', output: 'Adult' }],
    important_points: ['The condition MUST be a boolean expression — `if (1)` does not compile in Java, unlike C.', 'Braces {} are optional for a single statement but recommended.'],
    common_mistakes: ['Using = instead of == inside a condition — Java actually catches this at compile time since = doesn\'t produce a boolean.'],
    real_world: 'Eligibility checks (age, marks, balance) in almost any program start with an if statement like this.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        int age = 20;\n        if (age >= 18) {\n            System.out.println("Adult");\n        }\n    }\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'What must a Java if condition evaluate to?', options: ['int', 'boolean', 'String', 'Any type'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an integer n. Print "Positive" if n > 0.', language: 'java', starter_code: 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int n = sc.nextInt();\n        // write your code here\n    }\n}\n', test_cases: [{ input: '5', expected_output: 'Positive' }, { input: '-3', expected_output: '' }] }
    ]
  }),
  lesson(2, 'if-else', 5, {
    explanation: 'if-else runs one block when the condition is true and a different block when it is false, covering both outcomes with one statement.',
    syntax: 'if (condition) {\n    // true branch\n} else {\n    // false branch\n}',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        int age = 15;\n        if (age >= 18) System.out.println("Adult");\n        else System.out.println("Minor");\n    }\n}', output: 'Minor' }],
    important_points: ['Exactly one of the two branches runs.', 'The else pairs with the nearest unmatched if.'],
    common_mistakes: ['Adding a stray semicolon right after if(condition); which makes the if body empty.'],
    real_world: 'Pass/fail grading, login success/failure — any two-outcome decision uses if-else.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        int age = 15;\n        if (age >= 18) System.out.println("Adult");\n        else System.out.println("Minor");\n    }\n}\n' }, {
    questions: [{ id: qid('q'), type: 'code', text: 'Read an integer n. Print "Even" if divisible by 2, else "Odd".', language: 'java', starter_code: 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int n = sc.nextInt();\n        // write your code here\n    }\n}\n', test_cases: [{ input: '4', expected_output: 'Even' }, { input: '7', expected_output: 'Odd' }] }]
  }),
  lesson(3, 'else if', 5, {
    explanation: 'else if chains multiple conditions, checked in order, stopping at the first one that\'s true — used when there are more than two possible outcomes.',
    syntax: 'if (c1) { }\nelse if (c2) { }\nelse { }',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        int marks = 75;\n        if (marks >= 90) System.out.println("A");\n        else if (marks >= 75) System.out.println("B");\n        else System.out.println("C");\n    }\n}', output: 'B' }],
    important_points: ['Conditions are checked top to bottom; the first true one wins.', 'A trailing else (if present) catches everything unmatched.'],
    common_mistakes: ['Writing overlapping range checks in the wrong order.'],
    real_world: 'Grade calculators and tax-slab calculators are classic else-if chains.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        int marks = 75;\n        if (marks >= 90) System.out.println("A");\n        else if (marks >= 75) System.out.println("B");\n        else System.out.println("C");\n    }\n}\n' }, {
    questions: [{ id: qid('q'), type: 'code', text: 'Read marks (int). Print "A" if >=90, "B" if >=75, else "C".', language: 'java', starter_code: 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int marks = sc.nextInt();\n        // write your code here\n    }\n}\n', test_cases: [{ input: '95', expected_output: 'A' }, { input: '80', expected_output: 'B' }, { input: '50', expected_output: 'C' }] }]
  }),
  lesson(4, 'switch', 5, {
    explanation: 'switch compares one value against several fixed cases, running the matching branch — Java\'s switch works on int, char, String, and enums.',
    syntax: 'switch (value) {\n    case 1: ...; break;\n    default: ...;\n}',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        int day = 3;\n        switch (day) {\n            case 1: System.out.println("Mon"); break;\n            case 2: System.out.println("Tue"); break;\n            case 3: System.out.println("Wed"); break;\n            default: System.out.println("Other");\n        }\n    }\n}', output: 'Wed' }],
    important_points: ['Java\'s switch can match on String values directly, unlike C.', 'Without break, execution falls through into the next case.'],
    common_mistakes: ['Forgetting break; and getting unintended fall-through.'],
    real_world: 'Menu-driven console programs (1=Add, 2=Delete, 3=Exit) are a textbook switch use case.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        int day = 3;\n        switch (day) {\n            case 1: System.out.println("Mon"); break;\n            case 2: System.out.println("Tue"); break;\n            case 3: System.out.println("Wed"); break;\n            default: System.out.println("Other");\n        }\n    }\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Unlike C, Java\'s switch can also match directly on which type?', options: ['double', 'String', 'boolean', 'float'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an int 1-3 and print "One"/"Two"/"Three" using switch; print "Invalid" otherwise.', language: 'java', starter_code: 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int n = sc.nextInt();\n        // write your code here\n    }\n}\n', test_cases: [{ input: '2', expected_output: 'Two' }, { input: '9', expected_output: 'Invalid' }] }
    ]
  }),
  lesson(5, 'for Loop', 6, {
    explanation: 'A for loop repeats code a known number of times, combining initialization, condition, and update in one line.',
    syntax: 'for (init; condition; update) {\n    // body\n}',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        for (int i = 1; i <= 5; i++) {\n            System.out.print(i + " ");\n        }\n    }\n}', output: '1 2 3 4 5 ' }],
    important_points: ['The loop condition is checked before every iteration.', 'Java also has a "for-each" loop (for (int x : array)) for iterating collections/arrays directly.'],
    common_mistakes: ['Off-by-one errors from using <= vs < incorrectly.'],
    real_world: 'Printing a multiplication table or processing every element of an array uses a for loop.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        for (int i = 1; i <= 5; i++) {\n            System.out.print(i + " ");\n        }\n    }\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'output', text: 'What does this print?\nfor (int i = 0; i < 3; i++) System.out.print(i);', options: ['123', '012', '0123', '1 2 3'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an integer n and print the sum of 1 to n using a for loop.', language: 'java', starter_code: 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int n = sc.nextInt();\n        // write your code here\n    }\n}\n', test_cases: [{ input: '5', expected_output: '15' }, { input: '10', expected_output: '55' }] }
    ]
  }),
  lesson(6, 'while Loop', 5, {
    explanation: 'A while loop repeats code as long as its condition stays true, checked before each iteration — used when the number of repetitions isn\'t known in advance.',
    syntax: 'while (condition) {\n    // body\n}',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        int i = 1;\n        while (i <= 5) {\n            System.out.print(i + " ");\n            i++;\n        }\n    }\n}', output: '1 2 3 4 5 ' }],
    important_points: ['The loop variable must be updated inside the loop, or it runs forever.', 'The condition is checked BEFORE the body — the body might never run.'],
    common_mistakes: ['Forgetting to update the loop variable, causing an infinite loop.'],
    real_world: 'Reading input until a sentinel value appears is a classic while-loop pattern.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        int i = 1;\n        while (i <= 5) {\n            System.out.print(i + " ");\n            i++;\n        }\n    }\n}\n' }, stubTest('while Loop')),
  lesson(7, 'do-while Loop', 5, {
    explanation: 'A do-while loop runs its body once BEFORE checking the condition, guaranteeing at least one execution.',
    syntax: 'do {\n    // body\n} while (condition);',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        int i = 1;\n        do {\n            System.out.print(i + " ");\n            i++;\n        } while (i <= 5);\n    }\n}', output: '1 2 3 4 5 ' }],
    important_points: ['The body always runs at least once.', 'Note the required semicolon after while(condition);.'],
    common_mistakes: ['Forgetting the trailing semicolon after the while(condition) in a do-while.'],
    real_world: 'A "menu, then ask to repeat?" loop is naturally a do-while — show the menu at least once.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        int i = 1;\n        do {\n            System.out.print(i + " ");\n            i++;\n        } while (i <= 5);\n    }\n}\n' }, stubTest('do-while Loop')),
  lesson(8, 'break', 4, {
    explanation: 'break immediately exits the nearest enclosing loop (or switch), skipping any remaining iterations.',
    syntax: 'break;',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        for (int i = 1; i <= 10; i++) {\n            if (i == 5) break;\n            System.out.print(i + " ");\n        }\n    }\n}', output: '1 2 3 4 ' }],
    important_points: ['break exits only the single closest loop.', 'Commonly used to stop searching once a match is found.'],
    common_mistakes: ['Expecting break to exit multiple nested loops at once — it only exits the innermost one (use a labeled break for that).'],
    real_world: 'Searching a list and stopping as soon as the target is found uses break to avoid needless iterations.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        for (int i = 1; i <= 10; i++) {\n            if (i == 5) break;\n            System.out.print(i + " ");\n        }\n    }\n}\n' }, {
    questions: [{ id: qid('q'), type: 'code', text: 'Print numbers 1 to 10, but stop (break) as soon as you reach a number greater than 6.', language: 'java', starter_code: 'public class Main {\n    public static void main(String[] args) {\n        // write your code here\n    }\n}\n', test_cases: [{ input: '', expected_output: '1 2 3 4 5 6 ' }] }]
  }),
  lesson(9, 'continue', 4, {
    explanation: 'continue skips the rest of the current iteration and jumps to the loop\'s next check/update, without exiting the loop entirely.',
    syntax: 'continue;',
    examples: [{ code: 'public class Main {\n    public static void main(String[] args) {\n        for (int i = 1; i <= 5; i++) {\n            if (i == 3) continue;\n            System.out.print(i + " ");\n        }\n    }\n}', output: '1 2 4 5 ' }],
    important_points: ['continue skips only the current iteration.', 'In a for loop, the update step still runs after continue.'],
    common_mistakes: ['Confusing continue (skip this iteration) with break (exit the loop entirely).'],
    real_world: 'Skipping invalid/blank rows while processing a file line by line is a natural use of continue.'
  }, { starter_code: 'public class Main {\n    public static void main(String[] args) {\n        for (int i = 1; i <= 5; i++) {\n            if (i == 3) continue;\n            System.out.print(i + " ");\n        }\n    }\n}\n' }, {
    questions: [{ id: qid('q'), type: 'code', text: 'Print numbers 1 to 6, skipping (continue) any even number.', language: 'java', starter_code: 'public class Main {\n    public static void main(String[] args) {\n        // write your code here\n    }\n}\n', test_cases: [{ input: '', expected_output: '1 3 5 ' }] }]
  })
];

const JS_MODULE2_LESSONS = [
  lesson(1, 'if Statement', 5, {
    explanation: 'The if statement runs a block of code only when its condition is "truthy". JavaScript treats 0, "", null, undefined, and NaN as falsy — everything else is truthy.',
    syntax: 'if (condition) {\n    // statements\n}',
    examples: [{ code: 'let age = 20;\nif (age >= 18) {\n    console.log("Adult");\n}', output: 'Adult' }],
    important_points: ['JavaScript has real true/false booleans, but also coerces other values to truthy/falsy in conditions.', '"", 0, null, undefined, NaN, and false are the only falsy values.'],
    common_mistakes: ['Assuming an empty array [] or empty object {} is falsy — they are actually truthy in JavaScript.'],
    real_world: 'Eligibility checks (age, marks, balance) in almost any program start with an if statement like this.'
  }, { starter_code: 'let age = 20;\nif (age >= 18) {\n    console.log("Adult");\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Which of these is a FALSY value in JavaScript?', options: ['[]', '{}', '""', '"false"'], correct_index: 2 },
      { id: qid('q'), type: 'code', text: 'Read an integer n. Print "Positive" if n > 0.', language: 'javascript', starter_code: '// write your code here\n', test_cases: [{ input: '5', expected_output: 'Positive' }, { input: '-3', expected_output: '' }] }
    ]
  }),
  lesson(2, 'if-else', 5, {
    explanation: 'if-else runs one block when the condition is truthy and a different block when it is falsy, covering both outcomes with one statement.',
    syntax: 'if (condition) {\n    // true branch\n} else {\n    // false branch\n}',
    examples: [{ code: 'let age = 15;\nif (age >= 18) console.log("Adult");\nelse console.log("Minor");', output: 'Minor' }],
    important_points: ['Exactly one branch runs.', 'JavaScript also has a ternary shorthand: age >= 18 ? "Adult" : "Minor".'],
    common_mistakes: ['Adding a stray semicolon right after if(condition); which makes the if body empty.'],
    real_world: 'Pass/fail grading, login success/failure — any two-outcome decision uses if-else.'
  }, { starter_code: 'let age = 15;\nif (age >= 18) console.log("Adult");\nelse console.log("Minor");\n' }, {
    questions: [{ id: qid('q'), type: 'code', text: 'Read an integer n. Print "Even" if divisible by 2, else "Odd".', language: 'javascript', starter_code: '// write your code here\n', test_cases: [{ input: '4', expected_output: 'Even' }, { input: '7', expected_output: 'Odd' }] }]
  }),
  lesson(3, 'else if', 5, {
    explanation: 'else if chains multiple conditions, checked in order, stopping at the first one that\'s truthy — used when there are more than two possible outcomes.',
    syntax: 'if (c1) { }\nelse if (c2) { }\nelse { }',
    examples: [{ code: 'let marks = 75;\nif (marks >= 90) console.log("A");\nelse if (marks >= 75) console.log("B");\nelse console.log("C");', output: 'B' }],
    important_points: ['Conditions are checked top to bottom; the first true one wins.', 'A trailing else (if present) catches everything unmatched.'],
    common_mistakes: ['Writing overlapping range checks in the wrong order.'],
    real_world: 'Grade calculators and tax-slab calculators are classic else-if chains.'
  }, { starter_code: 'let marks = 75;\nif (marks >= 90) console.log("A");\nelse if (marks >= 75) console.log("B");\nelse console.log("C");\n' }, {
    questions: [{ id: qid('q'), type: 'code', text: 'Read marks (int). Print "A" if >=90, "B" if >=75, else "C".', language: 'javascript', starter_code: '// write your code here\n', test_cases: [{ input: '95', expected_output: 'A' }, { input: '80', expected_output: 'B' }, { input: '50', expected_output: 'C' }] }]
  }),
  lesson(4, 'switch', 5, {
    explanation: 'switch compares one value against several fixed cases using strict equality (===), running the matching branch\'s code.',
    syntax: 'switch (value) {\n    case 1: ...; break;\n    default: ...;\n}',
    examples: [{ code: 'let day = 3;\nswitch (day) {\n    case 1: console.log("Mon"); break;\n    case 2: console.log("Tue"); break;\n    case 3: console.log("Wed"); break;\n    default: console.log("Other");\n}', output: 'Wed' }],
    important_points: ['switch compares using === (strict equality), so "3" would NOT match case 3.', 'Without break, execution falls through into the next case.'],
    common_mistakes: ['Forgetting break; and getting unintended fall-through.'],
    real_world: 'Menu-driven console programs (1=Add, 2=Delete, 3=Exit) are a textbook switch use case.'
  }, { starter_code: 'let day = 3;\nswitch (day) {\n    case 1: console.log("Mon"); break;\n    case 2: console.log("Tue"); break;\n    case 3: console.log("Wed"); break;\n    default: console.log("Other");\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'mcq', text: 'Does JavaScript\'s switch use == or === to compare?', options: ['==', '===', 'Neither, it uses typeof', 'It depends on the case type'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an int 1-3 and print "One"/"Two"/"Three" using switch; print "Invalid" otherwise.', language: 'javascript', starter_code: '// write your code here\n', test_cases: [{ input: '2', expected_output: 'Two' }, { input: '9', expected_output: 'Invalid' }] }
    ]
  }),
  lesson(5, 'for Loop', 6, {
    explanation: 'A for loop repeats code a known number of times, combining initialization, condition, and update in one line.',
    syntax: 'for (let i = 0; i < n; i++) {\n    // body\n}',
    examples: [{ code: 'for (let i = 1; i <= 5; i++) {\n    process.stdout.write(i + " ");\n}', output: '1 2 3 4 5 ' }],
    important_points: ['Always declare the loop variable with let, not var, to keep it block-scoped to the loop.', 'JavaScript also has for...of (iterate values) and for...in (iterate keys) for collections.'],
    common_mistakes: ['Off-by-one errors from using <= vs < incorrectly.'],
    real_world: 'Printing a multiplication table or processing every element of an array uses a for loop.'
  }, { starter_code: 'for (let i = 1; i <= 5; i++) {\n    process.stdout.write(i + " ");\n}\n' }, {
    questions: [
      { id: qid('q'), type: 'output', text: 'What does this print?\nfor (let i = 0; i < 3; i++) process.stdout.write(String(i));', options: ['123', '012', '0123', '1 2 3'], correct_index: 1 },
      { id: qid('q'), type: 'code', text: 'Read an integer n and print the sum of 1 to n using a for loop.', language: 'javascript', starter_code: '// write your code here\n', test_cases: [{ input: '5', expected_output: '15' }, { input: '10', expected_output: '55' }] }
    ]
  }),
  lesson(6, 'while Loop', 5, {
    explanation: 'A while loop repeats code as long as its condition stays truthy, checked before each iteration — used when the number of repetitions isn\'t known in advance.',
    syntax: 'while (condition) {\n    // body\n}',
    examples: [{ code: 'let i = 1;\nwhile (i <= 5) {\n    process.stdout.write(i + " ");\n    i++;\n}', output: '1 2 3 4 5 ' }],
    important_points: ['The loop variable must be updated inside the loop, or it runs forever.', 'The condition is checked BEFORE the body — the body might never run.'],
    common_mistakes: ['Forgetting to update the loop variable, causing an infinite loop.'],
    real_world: 'Reading input until a sentinel value appears is a classic while-loop pattern.'
  }, { starter_code: 'let i = 1;\nwhile (i <= 5) {\n    process.stdout.write(i + " ");\n    i++;\n}\n' }, stubTest('while Loop')),
  lesson(7, 'do-while Loop', 5, {
    explanation: 'A do-while loop runs its body once BEFORE checking the condition, guaranteeing at least one execution.',
    syntax: 'do {\n    // body\n} while (condition);',
    examples: [{ code: 'let i = 1;\ndo {\n    process.stdout.write(i + " ");\n    i++;\n} while (i <= 5);', output: '1 2 3 4 5 ' }],
    important_points: ['The body always runs at least once.', 'Note the required semicolon after while(condition);.'],
    common_mistakes: ['Forgetting the trailing semicolon after the while(condition) in a do-while.'],
    real_world: 'A "menu, then ask to repeat?" loop is naturally a do-while — show the menu at least once.'
  }, { starter_code: 'let i = 1;\ndo {\n    process.stdout.write(i + " ");\n    i++;\n} while (i <= 5);\n' }, stubTest('do-while Loop')),
  lesson(8, 'break', 4, {
    explanation: 'break immediately exits the nearest enclosing loop (or switch), skipping any remaining iterations.',
    syntax: 'break;',
    examples: [{ code: 'for (let i = 1; i <= 10; i++) {\n    if (i === 5) break;\n    process.stdout.write(i + " ");\n}', output: '1 2 3 4 ' }],
    important_points: ['break exits only the single closest loop.', 'Commonly used to stop searching once a match is found.'],
    common_mistakes: ['Expecting break to exit multiple nested loops at once — it only exits the innermost one (a labeled break is needed for that).'],
    real_world: 'Searching an array and stopping as soon as the target is found uses break to avoid needless iterations.'
  }, { starter_code: 'for (let i = 1; i <= 10; i++) {\n    if (i === 5) break;\n    process.stdout.write(i + " ");\n}\n' }, {
    questions: [{ id: qid('q'), type: 'code', text: 'Print numbers 1 to 10, but stop (break) as soon as you reach a number greater than 6.', language: 'javascript', starter_code: '// write your code here\n', test_cases: [{ input: '', expected_output: '1 2 3 4 5 6 ' }] }]
  }),
  lesson(9, 'continue', 4, {
    explanation: 'continue skips the rest of the current iteration and jumps to the loop\'s next check/update, without exiting the loop entirely.',
    syntax: 'continue;',
    examples: [{ code: 'for (let i = 1; i <= 5; i++) {\n    if (i === 3) continue;\n    process.stdout.write(i + " ");\n}', output: '1 2 4 5 ' }],
    important_points: ['continue skips only the current iteration.', 'In a for loop, the update step still runs after continue.'],
    common_mistakes: ['Confusing continue (skip this iteration) with break (exit the loop entirely).'],
    real_world: 'Skipping invalid/blank entries while processing an array of form data is a natural use of continue.'
  }, { starter_code: 'for (let i = 1; i <= 5; i++) {\n    if (i === 3) continue;\n    process.stdout.write(i + " ");\n}\n' }, {
    questions: [{ id: qid('q'), type: 'code', text: 'Print numbers 1 to 6, skipping (continue) any even number.', language: 'javascript', starter_code: '// write your code here\n', test_cases: [{ input: '', expected_output: '1 3 5 ' }] }]
  })
];

// ---------------------------------------------------------------------------
// Per-language module outlines. Titles match the course brief for Python;
// C/C++/Java/JavaScript use the equivalent standard progression for that
// language so the same 15-module shape holds across every course card.
// ---------------------------------------------------------------------------
const OUTLINES = {
  c: [
    { id: 'm1', title: 'C Fundamentals', tier: 'beginner', lessons: ['Introduction to C', 'C Features', 'Installing / Running C', 'Structure of a C Program', 'Variables', 'Data Types', 'Input and Output', 'Type Casting', 'Operators', 'Comments'] },
    { id: 'm2', title: 'Control Flow', tier: 'beginner', lessons: ['if Statement', 'if-else', 'else if', 'Nested Conditions', 'switch', 'for Loop', 'while Loop', 'do-while Loop', 'break', 'continue'] },
    { id: 'm3', title: 'Arrays and Strings', tier: 'beginner', lessons: ['Array Basics', '1D Arrays', '2D Arrays', 'Array Practice', 'String Basics', 'String Functions', 'String Practice'] },
    { id: 'm4', title: 'Pointers', tier: 'intermediate', lessons: ['Pointer Introduction', 'Pointer Arithmetic', 'Pointers and Arrays', 'Pointers and Functions', 'Double Pointers', 'Pointer Practice'] },
    { id: 'm5', title: 'Functions', tier: 'intermediate', lessons: ['Function Basics', 'Parameters', 'Return Values', 'Recursion', 'Function Practice'] },
    { id: 'm6', title: 'Structures and Unions', tier: 'intermediate', lessons: ['struct Basics', 'Nested Structures', 'Arrays of Structures', 'Structures and Pointers', 'Unions', 'Practice'] },
    { id: 'm7', title: 'Memory Management', tier: 'intermediate', lessons: ['Stack vs Heap', 'malloc', 'calloc', 'realloc', 'free', 'Memory Leaks'] },
    { id: 'm8', title: 'File Handling', tier: 'intermediate', lessons: ['Opening Files', 'Reading Files', 'Writing Files', 'File Modes', 'Closing Files'] },
    { id: 'm9', title: 'Preprocessor', tier: 'intermediate', lessons: ['Macros', '#define', '#include', 'Conditional Compilation'] },
    { id: 'm10', title: 'Storage Classes', tier: 'advanced', lessons: ['auto', 'static', 'extern', 'register'] },
    { id: 'm11', title: 'Advanced C', tier: 'advanced', lessons: ['Bitwise Operators', 'Function Pointers', 'Command Line Arguments', 'typedef', 'Enums'] },
    { id: 'm12', title: 'Error Handling', tier: 'advanced', lessons: ['errno', 'perror', 'Defensive Coding'] },
    { id: 'm13', title: 'C + Data Structures', tier: 'advanced', lessons: ['Linked Lists', 'Stacks', 'Queues', 'Searching', 'Sorting'] },
    { id: 'm14', title: 'DSA with C', tier: 'advanced', lessons: ['Arrays', 'Trees Basics', 'Problem Solving', 'Complexity Basics'] },
    { id: 'm15', title: 'Real-world Projects', tier: 'advanced', lessons: ['Calculator', 'Student Record System', 'Library Management', 'Final C Project'] }
  ],
  cpp: [
    { id: 'm1', tier: 'beginner', title: 'C++ Fundamentals', lessons: ['Introduction to C++', 'C++ Features', 'Installing / Running C++', 'Structure of a C++ Program', 'Variables', 'Data Types', 'Input and Output', 'Type Casting', 'Operators', 'Comments'] },
    { id: 'm2', tier: 'beginner', title: 'Control Flow', lessons: ['if Statement', 'if-else', 'else if', 'Nested Conditions', 'switch', 'for Loop', 'while Loop', 'do-while Loop', 'break', 'continue'] },
    { id: 'm3', tier: 'beginner', title: 'Arrays and Strings', lessons: ['Array Basics', '2D Arrays', 'std::string Basics', 'String Methods', 'Practice'] },
    { id: 'm4', tier: 'intermediate', title: 'Functions', lessons: ['Function Basics', 'Default Arguments', 'Function Overloading', 'Recursion', 'Inline Functions'] },
    { id: 'm5', tier: 'intermediate', title: 'Pointers and References', lessons: ['Pointer Basics', 'References', 'Pointers vs References', 'Dynamic Memory (new/delete)'] },
    { id: 'm6', tier: 'intermediate', title: 'Object-Oriented Programming', lessons: ['Classes', 'Objects', 'Constructors', 'Destructors', 'this Pointer', 'Encapsulation'] },
    { id: 'm7', tier: 'intermediate', title: 'Inheritance and Polymorphism', lessons: ['Inheritance Basics', 'Multiple Inheritance', 'Virtual Functions', 'Abstract Classes', 'Operator Overloading'] },
    { id: 'm8', tier: 'advanced', title: 'Templates', lessons: ['Function Templates', 'Class Templates', 'Template Practice'] },
    { id: 'm9', tier: 'advanced', title: 'STL', lessons: ['vector', 'map', 'set', 'pair', 'algorithm basics'] },
    { id: 'm10', tier: 'advanced', title: 'Exception Handling', lessons: ['try/catch', 'throw', 'Custom Exceptions'] },
    { id: 'm11', tier: 'advanced', title: 'File Handling', lessons: ['ifstream', 'ofstream', 'File Modes'] },
    { id: 'm12', tier: 'advanced', title: 'Advanced C++', lessons: ['Smart Pointers', 'Lambda Expressions', 'Move Semantics'] },
    { id: 'm13', tier: 'advanced', title: 'C++ + Data Structures', lessons: ['Linked Lists', 'Stacks', 'Queues', 'Searching', 'Sorting'] },
    { id: 'm14', tier: 'advanced', title: 'DSA with C++', lessons: ['Trees Basics', 'Graphs Basics', 'Problem Solving'] },
    { id: 'm15', tier: 'advanced', title: 'Real-world Projects', lessons: ['Calculator', 'Bank Management System', 'Inventory System', 'Final C++ Project'] }
  ],
  java: [
    { id: 'm1', title: 'Java Fundamentals', tier: 'beginner', lessons: ['Introduction to Java', 'Java Features', 'Installing / Running Java', 'Structure of a Java Program', 'Variables', 'Data Types', 'Input and Output', 'Type Casting', 'Operators', 'Comments'] },
    { id: 'm2', title: 'Control Flow', tier: 'beginner', lessons: ['if Statement', 'if-else', 'else if', 'switch', 'for Loop', 'while Loop', 'do-while Loop', 'break', 'continue'] },
    { id: 'm3', title: 'Arrays and Strings', tier: 'beginner', lessons: ['Array Basics', '2D Arrays', 'String Basics', 'String Methods', 'StringBuilder', 'Practice'] },
    { id: 'm4', title: 'Object-Oriented Programming', tier: 'intermediate', lessons: ['Classes and Objects', 'Constructors', 'this Keyword', 'Encapsulation', 'Static Members'] },
    { id: 'm5', title: 'Inheritance and Polymorphism', tier: 'intermediate', lessons: ['Inheritance Basics', 'super Keyword', 'Method Overriding', 'Abstract Classes', 'Interfaces'] },
    { id: 'm6', title: 'Collections', tier: 'intermediate', lessons: ['ArrayList', 'HashMap', 'HashSet', 'Iterators', 'Collections Practice'] },
    { id: 'm7', title: 'Exception Handling', tier: 'intermediate', lessons: ['try-catch', 'finally', 'throw', 'Custom Exceptions'] },
    { id: 'm8', title: 'File Handling', tier: 'advanced', lessons: ['File Class', 'FileReader/Writer', 'BufferedReader'] },
    { id: 'm9', title: 'Multithreading', tier: 'advanced', lessons: ['Thread Basics', 'Runnable', 'Synchronization'] },
    { id: 'm10', title: 'Generics', tier: 'advanced', lessons: ['Generic Methods', 'Generic Classes', 'Bounded Types'] },
    { id: 'm11', title: 'Advanced Java', tier: 'advanced', lessons: ['Lambda Expressions', 'Streams', 'Optional'] },
    { id: 'm12', title: 'Java + Database (JDBC)', tier: 'advanced', lessons: ['JDBC Basics', 'Connecting to a Database', 'CRUD Operations'] },
    { id: 'm13', title: 'Java + Data Structures', tier: 'advanced', lessons: ['Linked Lists', 'Stacks', 'Queues', 'Searching', 'Sorting'] },
    { id: 'm14', title: 'DSA with Java', tier: 'advanced', lessons: ['Trees Basics', 'Graphs Basics', 'Problem Solving'] },
    { id: 'm15', title: 'Real-world Projects', tier: 'advanced', lessons: ['Calculator', 'Student Management System', 'Library Management', 'Final Java Project'] }
  ],
  javascript: [
    { id: 'm1', tier: 'beginner', title: 'JavaScript Fundamentals', lessons: ['Introduction to JavaScript', 'JS Features', 'Running JavaScript', 'Variables (var/let/const)', 'Data Types', 'Input and Output (console)', 'Type Conversion', 'Operators', 'Comments'] },
    { id: 'm2', tier: 'beginner', title: 'Control Flow', lessons: ['if Statement', 'if-else', 'else if', 'switch', 'for Loop', 'while Loop', 'do-while Loop', 'break', 'continue'] },
    { id: 'm3', tier: 'beginner', title: 'Arrays and Strings', lessons: ['Array Basics', 'Array Methods', 'String Basics', 'String Methods', 'Template Literals', 'Practice'] },
    { id: 'm4', tier: 'intermediate', title: 'Functions', lessons: ['Function Basics', 'Arrow Functions', 'Default Parameters', 'Rest/Spread', 'Callbacks', 'Recursion'] },
    { id: 'm5', tier: 'intermediate', title: 'Objects', lessons: ['Object Basics', 'Object Methods', 'this Keyword', 'Object Destructuring', 'JSON'] },
    { id: 'm6', tier: 'intermediate', title: 'DOM Basics', lessons: ['DOM Introduction', 'Selecting Elements', 'Events', 'Modifying Elements'] },
    { id: 'm7', tier: 'intermediate', title: 'ES6+ Features', lessons: ['let/const', 'Arrow Functions Recap', 'Classes', 'Modules', 'Optional Chaining'] },
    { id: 'm8', tier: 'advanced', title: 'Asynchronous JavaScript', lessons: ['Callbacks', 'Promises', 'async/await', 'fetch()'] },
    { id: 'm9', tier: 'advanced', title: 'Error Handling', lessons: ['try-catch', 'throw', 'Custom Errors'] },
    { id: 'm10', tier: 'advanced', title: 'Object-Oriented JavaScript', lessons: ['Classes', 'Constructors', 'Inheritance', 'Encapsulation'] },
    { id: 'm11', tier: 'advanced', title: 'Advanced JavaScript', lessons: ['Closures', 'Higher-Order Functions', 'Prototype Chain', 'Iterators/Generators'] },
    { id: 'm12', tier: 'advanced', title: 'JavaScript + APIs', lessons: ['HTTP Basics', 'fetch API', 'JSON Handling', 'API Project'] },
    { id: 'm13', tier: 'advanced', title: 'JavaScript + Data Structures', lessons: ['Stacks', 'Queues', 'Linked Lists', 'Searching', 'Sorting'] },
    { id: 'm14', tier: 'advanced', title: 'DSA with JavaScript', lessons: ['Trees Basics', 'Graphs Basics', 'Problem Solving'] },
    { id: 'm15', tier: 'advanced', title: 'Real-world Projects', lessons: ['Calculator', 'To-Do App', 'Quiz Application', 'Final JavaScript Project'] }
  ]
};

// `moduleOverrides` (optional) maps a module's outline INDEX (0 for the
// first module, 1 for the second, ...) to an array of fully-authored
// lesson() objects for that module, by lesson order. Any module index not
// present in the map, and any lesson within an overridden module that has
// no entry, still falls back to stubLesson() exactly as before. This is
// how C/C++/Java/JavaScript get real, non-stub Module 1 + Module 2 content
// (see the *_MODULE1_LESSONS / *_MODULE2_LESSONS arrays above) while
// modules 3-15 remain stubs, same mechanism Python already uses for its
// own un-authored modules.
function buildStubCourse(outline, moduleOverrides) {
  const modules = outline.map((m, mi) => {
    const overrideForThisModule = moduleOverrides ? moduleOverrides[mi] : null;
    const lessons = m.lessons.map((title, li) => {
      const order = li + 1;
      const authored = overrideForThisModule ? overrideForThisModule[li] : null;
      const content = authored || stubLesson(order, title);
      return { id: `${m.id}-l${order}`, module_id: m.id, ...content, order, title: authored ? authored.title : title };
    });
    return { id: m.id, order: mi + 1, title: m.title, tier: m.tier || 'beginner', lessons };
  });
  const lessonIndex = new Map();
  const orderedLessonIds = [];
  modules.forEach(m => m.lessons.forEach(l => { lessonIndex.set(l.id, l); orderedLessonIds.push(l.id); }));
  return { modules, lessonIndex, orderedLessonIds };
}

const LANGUAGES = ['python', 'c', 'cpp', 'java', 'javascript'];

const LANGUAGE_META = {
  python: { label: 'Python', file_ext: '.py', judge0_name: 'python' },
  c: { label: 'C', file_ext: '.c', judge0_name: 'c' },
  cpp: { label: 'C++', file_ext: '.cpp', judge0_name: 'cpp' },
  java: { label: 'Java', file_ext: '.java', judge0_name: 'java' },
  javascript: { label: 'JavaScript', file_ext: '.js', judge0_name: 'javascript' }
};

// Python reuses the real, existing pythonCourseData.js course as-is.
// C/C++/Java/JavaScript now each get fully-authored Module 1 + Module 2
// content (see the *_MODULE1_LESSONS / *_MODULE2_LESSONS arrays above);
// modules 3-15 for all four are still built from the stub generator, same
// as Python's own un-authored modules.
const COURSES_BY_LANGUAGE = {
  python: PY_COURSE,
  c: buildStubCourse(OUTLINES.c, {
    0: C_MODULE1_LESSONS, 1: C_MODULE2_LESSONS,
    2: C_M3_15.M3, 3: C_M3_15.M4, 4: C_M3_15.M5, 5: C_M3_15.M6,
    6: C_M3_15.M7, 7: C_M3_15.M8, 8: C_M3_15.M9, 9: C_M3_15.M10,
    10: C_M3_15.M11, 11: C_M3_15.M12, 12: C_M3_15.M13, 13: C_M3_15.M14,
    14: C_M3_15.M15
  }),
  cpp: buildStubCourse(OUTLINES.cpp, {
    0: CPP_MODULE1_LESSONS, 1: CPP_MODULE2_LESSONS,
    2: CPP_M3_15.M3, 3: CPP_M3_15.M4, 4: CPP_M3_15.M5, 5: CPP_M3_15.M6,
    6: CPP_M3_15.M7, 7: CPP_M3_15.M8, 8: CPP_M3_15.M9, 9: CPP_M3_15.M10,
    10: CPP_M3_15.M11, 11: CPP_M3_15.M12, 12: CPP_M3_15.M13, 13: CPP_M3_15.M14,
    14: CPP_M3_15.M15
  }),
  java: buildStubCourse(OUTLINES.java, {
    0: JAVA_MODULE1_LESSONS, 1: JAVA_MODULE2_LESSONS,
    2: JAVA_M3_15.M3, 3: JAVA_M3_15.M4, 4: JAVA_M3_15.M5, 5: JAVA_M3_15.M6,
    6: JAVA_M3_15.M7, 7: JAVA_M3_15.M8, 8: JAVA_M3_15.M9, 9: JAVA_M3_15.M10,
    10: JAVA_M3_15.M11, 11: JAVA_M3_15.M12, 12: JAVA_M3_15.M13, 13: JAVA_M3_15.M14,
    14: JAVA_M3_15.M15
  }),
  javascript: buildStubCourse(OUTLINES.javascript, {
    0: JS_MODULE1_LESSONS, 1: JS_MODULE2_LESSONS,
    2: JS_M3_15.M3, 3: JS_M3_15.M4, 4: JS_M3_15.M5, 5: JS_M3_15.M6,
    6: JS_M3_15.M7, 7: JS_M3_15.M8, 8: JS_M3_15.M9, 9: JS_M3_15.M10,
    10: JS_M3_15.M11, 11: JS_M3_15.M12, 12: JS_M3_15.M13, 13: JS_M3_15.M14,
    14: JS_M3_15.M15
  })
};

const TOTAL_LESSONS_BY_LANGUAGE = {};
LANGUAGES.forEach(lang => { TOTAL_LESSONS_BY_LANGUAGE[lang] = COURSES_BY_LANGUAGE[lang].orderedLessonIds.length; });

function isValidLanguage(lang) {
  return LANGUAGES.includes(lang);
}

module.exports = {
  LANGUAGES,
  LANGUAGE_META,
  COURSES_BY_LANGUAGE,
  TOTAL_LESSONS_BY_LANGUAGE,
  isValidLanguage
};
