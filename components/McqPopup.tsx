import React, { useState, useMemo } from 'react';
import { X, Check, XCircle, RotateCcw, Trophy, ChevronRight, ChevronLeft } from 'lucide-react';
import type { McqSet, McqQuestion } from '../store/useMcqStore';

interface McqPopupProps {
  mcqSet: McqSet;
  onClose: () => void;
}

const normalizeAnswer = (answer: string): string => {
  const trimmed = answer.trim();
  const letterMatch = trimmed.match(/^([A-D])\)?\s*/i);
  if (letterMatch) {
    return letterMatch[1].toUpperCase();
  }
  return trimmed.toUpperCase();
};

const answersMatch = (selected: string, correct: string): boolean => {
  if (!selected || !correct) return false;
  const normSelected = normalizeAnswer(selected);
  const normCorrect = normalizeAnswer(correct);
  if (normSelected === normCorrect) return true;
  if (selected.includes(correct) || correct.includes(selected)) return true;
  return false;
};

export const McqPopup: React.FC<McqPopupProps> = ({ mcqSet, onClose }) => {
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, string>>({});
  const [showResults, setShowResults] = useState(false);
  const [revealedQuestions, setRevealedQuestions] = useState<Set<number>>(new Set());

  const questions = mcqSet.questions;
  const totalQuestions = questions.length;

  const score = useMemo(() => {
    let correct = 0;
    for (let i = 0; i < totalQuestions; i++) {
      if (selectedAnswers[i] && answersMatch(selectedAnswers[i], questions[i].answer)) {
        correct++;
      }
    }
    return correct;
  }, [selectedAnswers, questions, totalQuestions]);

  const scorePercent = totalQuestions > 0 ? Math.round((score / totalQuestions) * 100) : 0;

  const getGrade = () => {
    if (scorePercent >= 90) return { label: 'Excellent!', color: 'text-emerald-400' };
    if (scorePercent >= 70) return { label: 'Good Job!', color: 'text-blue-400' };
    if (scorePercent >= 50) return { label: 'Keep Trying!', color: 'text-yellow-400' };
    return { label: 'Needs Work', color: 'text-red-400' };
  };

  const handleSelectAnswer = (questionIndex: number, option: string) => {
    if (showResults) return;
    setSelectedAnswers(prev => ({ ...prev, [questionIndex]: option }));
  };

  const handleNext = () => {
    if (currentQuestion < totalQuestions - 1) {
      setCurrentQuestion(prev => prev + 1);
    } else {
      setShowResults(true);
    }
  };

  const handlePrev = () => {
    if (currentQuestion > 0) {
      setCurrentQuestion(prev => prev - 1);
    }
  };

  const handleRetake = () => {
    setCurrentQuestion(0);
    setSelectedAnswers({});
    setShowResults(false);
    setRevealedQuestions(new Set());
  };

  const handleReveal = (questionIndex: number) => {
    setRevealedQuestions(prev => new Set([...prev, questionIndex]));
  };

  const isAnswered = (questionIndex: number) => selectedAnswers[questionIndex] !== undefined;
  const isCorrect = (questionIndex: number) => {
    const selected = selectedAnswers[questionIndex];
    return selected && answersMatch(selected, questions[questionIndex].answer);
  };

  const getCorrectOption = (questionIndex: number): string => {
    const correctAnswer = questions[questionIndex].answer;
    const normCorrect = normalizeAnswer(correctAnswer);
    for (const option of questions[questionIndex].options) {
      if (normalizeAnswer(option) === normCorrect || option.includes(correctAnswer) || correctAnswer.includes(option.charAt(0))) {
        return option;
      }
    }
    return correctAnswer;
  };

  const getOptionStyle = (questionIndex: number, option: string) => {
    const selected = selectedAnswers[questionIndex];
    const correct = questions[questionIndex].answer;
    const isRevealed = revealedQuestions.has(questionIndex);

    if (showResults || isRevealed) {
      if (answersMatch(option, correct)) {
        return 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200';
      }
      if (selected === option && !answersMatch(option, correct)) {
        return 'border-red-400/60 bg-red-500/15 text-red-200';
      }
      return 'border-white/10 bg-white/[0.03] text-gray-500';
    }

    if (selected === option) {
      return 'border-purple-400/60 bg-purple-500/15 text-purple-200';
    }
    return 'border-white/10 bg-white/[0.03] text-gray-300 hover:border-white/20 hover:bg-white/[0.06]';
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative w-full max-w-2xl max-h-[85vh] bg-[#101720] border border-[#233245] rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#233245]">
          <div>
            <h2 className="text-sm font-bold text-[#eef4ff]">{mcqSet.title}</h2>
            <p className="text-[11px] text-[#94a1b8]">{totalQuestions} questions</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-[#94a1b8] hover:text-[#eef4ff] hover:bg-white/10 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Progress Bar */}
        {!showResults && (
          <div className="px-5 py-2 border-b border-[#233245]">
            <div className="flex items-center justify-between text-[10px] text-[#748196] mb-1">
              <span>Question {currentQuestion + 1} of {totalQuestions}</span>
              <span>{Object.keys(selectedAnswers).length} answered</span>
            </div>
            <div className="h-1.5 rounded-full bg-[#233245] overflow-hidden">
              <div
                className="h-full rounded-full bg-[#5a9aff] transition-all duration-300"
                style={{ width: `${((currentQuestion + 1) / totalQuestions) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-5">
          {showResults ? (
            <div className="flex flex-col items-center text-center">
              <div className="mb-4">
                <Trophy size={48} className={getGrade().color} />
              </div>
              <h3 className={`text-2xl font-bold ${getGrade().color} mb-2`}>{getGrade().label}</h3>
              <div className="text-4xl font-bold text-[#eef4ff] mb-1">{scorePercent}%</div>
              <p className="text-sm text-[#94a1b8] mb-6">{score} out of {totalQuestions} correct</p>

              <div className="w-full space-y-2 mb-6">
                {questions.map((q, idx) => {
                  const userAnswer = selectedAnswers[idx];
                  const correct = answersMatch(userAnswer, q.answer);
                  const correctOption = getCorrectOption(idx);
                  return (
                    <div
                      key={idx}
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left ${
                        correct
                          ? 'border-emerald-400/30 bg-emerald-500/10'
                          : 'border-red-400/30 bg-red-500/10'
                      }`}
                    >
                      {correct ? (
                        <Check size={14} className="text-emerald-400 shrink-0" />
                      ) : (
                        <XCircle size={14} className="text-red-400 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-[#d8e0ee] truncate">{q.question}</div>
                        {!correct && (
                          <div className="text-[10px] text-[#94a1b8] mt-0.5">
                            Your answer: <span className="text-red-300">{userAnswer || 'Not answered'}</span>
                            {' • '}
                            Correct: <span className="text-emerald-300">{correctOption}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleRetake}
                  className="flex items-center gap-2 rounded-lg border border-[#5a9aff]/30 bg-[#5a9aff]/10 px-4 py-2 text-sm font-semibold text-[#5a9aff] hover:bg-[#5a9aff]/20 transition-colors"
                >
                  <RotateCcw size={14} /> Retake Quiz
                </button>
                <button
                  onClick={onClose}
                  className="rounded-lg border border-[#233245] bg-white/[0.04] px-4 py-2 text-sm text-[#94a1b8] hover:bg-white/[0.08] transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <div>
              {/* Question */}
              <div className="mb-4">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#5a9aff]">
                  Question {currentQuestion + 1}
                </span>
                <h3 className="text-base font-semibold text-[#eef4ff] mt-1">
                  {questions[currentQuestion].question}
                </h3>
              </div>

              {/* Options */}
              <div className="space-y-2 mb-4">
                {questions[currentQuestion].options.map((option, optIdx) => (
                  <button
                    key={optIdx}
                    onClick={() => handleSelectAnswer(currentQuestion, option)}
                    className={`w-full text-left rounded-lg border px-4 py-3 text-sm transition-all ${getOptionStyle(currentQuestion, option)}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-bold">
                        {String.fromCharCode(65 + optIdx)}
                      </span>
                      <span>{option}</span>
                    </div>
                  </button>
                ))}
              </div>

              {/* Explanation (shown after answering or revealing) */}
              {(isAnswered(currentQuestion) || revealedQuestions.has(currentQuestion)) && (
                <div className="rounded-lg border border-[#233245] bg-[#141d28] p-3 mb-4">
                  <div className="flex items-center gap-2 mb-1">
                    {isCorrect(currentQuestion) ? (
                      <Check size={14} className="text-emerald-400" />
                    ) : (
                      <XCircle size={14} className="text-red-400" />
                    )}
                    <span className={`text-xs font-semibold ${isCorrect(currentQuestion) ? 'text-emerald-400' : 'text-red-400'}`}>
                      {isCorrect(currentQuestion) ? 'Correct!' : `Wrong! Answer: ${getCorrectOption(currentQuestion)}`}
                    </span>
                  </div>
                  {questions[currentQuestion].explanation && (
                    <p className="text-xs text-[#94a1b8] mt-1">{questions[currentQuestion].explanation}</p>
                  )}
                </div>
              )}

              {/* Navigation */}
              <div className="flex items-center justify-between">
                <button
                  onClick={handlePrev}
                  disabled={currentQuestion === 0}
                  className="flex items-center gap-1 rounded-lg border border-[#233245] bg-white/[0.04] px-3 py-2 text-xs text-[#94a1b8] hover:bg-white/[0.08] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={14} /> Previous
                </button>

                <button
                  onClick={() => handleReveal(currentQuestion)}
                  className="rounded-lg border border-[#233245] bg-white/[0.04] px-3 py-2 text-xs text-[#94a1b8] hover:bg-white/[0.08] transition-colors"
                >
                  Reveal Answer
                </button>

                <button
                  onClick={handleNext}
                  className="flex items-center gap-1 rounded-lg bg-[#5a9aff] px-4 py-2 text-xs font-semibold text-[#08111d] hover:bg-[#86b6ff] transition-colors"
                >
                  {currentQuestion < totalQuestions - 1 ? (
                    <>Next <ChevronRight size={14} /></>
                  ) : (
                    <>Finish <Trophy size={14} /></>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
