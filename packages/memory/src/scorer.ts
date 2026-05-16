import type { Memory } from "./types.js";

export class MemoryScorer {
  scoreImportance(content: string): number {
    const trimmed = content.trim();
    if (!trimmed) {
      return 0;
    }

    const normalized = trimmed.toLowerCase();
    if (
      isTrivialConversation(normalized) ||
      isOrdinaryQuestion(normalized) ||
      mentionsFailedOrUncertainAnswer(normalized)
    ) {
      return 0;
    }

    if (mentionsExplicitRemember(normalized)) {
      return 0.95;
    }

    if (mentionsStableProviderChoice(normalized)) {
      return 0.85;
    }

    if (mentionsStablePathOrRepository(normalized)) {
      return 0.8;
    }

    if (mentionsProjectMilestone(normalized)) {
      return 0.75;
    }

    if (mentionsStablePreferenceOrWorkflow(normalized)) {
      return 0.7;
    }

    if (mentionsTroubleshootingOrConfig(normalized)) {
      return 0.68;
    }

    return Math.min(0.5, Math.max(0, trimmed.length / 1800));
  }

  rank(memories: Memory[]): Memory[] {
    return [...memories].sort((left, right) => {
      const importanceDelta = right.importance - left.importance;
      if (importanceDelta !== 0) {
        return importanceDelta;
      }

      return right.lastAccessedAt.getTime() - left.lastAccessedAt.getTime();
    });
  }
}

function isTrivialConversation(text: string): boolean {
  return /^(hi|hello|hey|你好|您好|哈喽|嗨)[!.。！\s]*$/iu.test(text);
}

function isOrdinaryQuestion(text: string): boolean {
  if (mentionsStableSignal(text)) {
    return false;
  }

  return /[?？]\s*$/u.test(text) && text.length < 160;
}

function mentionsExplicitRemember(text: string): boolean {
  return /\bremember\b|\bnote this\b|\bfor future\b|记住|请记住|以后|下次/u.test(text);
}

function mentionsStableProviderChoice(text: string): boolean {
  return /(deepseek|xai|dashscope|通义|阿里云|provider|供应商|模型).*(prefer|默认|使用|选择|provider|chat|reasoning|tts|stt|vision)|(?:chat|reasoning|tts|stt|vision).*(deepseek|xai|dashscope)/iu.test(
    text
  );
}

function mentionsStablePathOrRepository(text: string): boolean {
  return /(repo|repository|仓库|项目路径|路径|目录|workspace|工作区|\/home\/|c:\\|\\\\wsl|github)/iu.test(
    text
  );
}

function mentionsProjectMilestone(text: string): boolean {
  return /(完成|已完成|implemented|finished|done|milestone|里程碑|上线|通过验证|validation passed|all validation passed)/iu.test(
    text
  );
}

function mentionsStablePreferenceOrWorkflow(text: string): boolean {
  return /(prefer|preference|always|默认|偏好|习惯|规则|workflow|流程|以后都|不要|必须|应该)/iu.test(
    text
  );
}

function mentionsTroubleshootingOrConfig(text: string): boolean {
  return /(root cause|原因是|排错结论|解决办法|config|配置|\.env|端口|port|database_url|memory_repository)/iu.test(
    text
  );
}

function mentionsFailedOrUncertainAnswer(text: string): boolean {
  return /(i don'?t know|cannot determine|can't determine|not enough context|lack context|lacks context|unable to answer|无法确定|不知道|缺少上下文|没有足够上下文|不能判断|无法判断)/iu.test(
    text
  );
}

function mentionsStableSignal(text: string): boolean {
  return (
    mentionsExplicitRemember(text) ||
    mentionsStableProviderChoice(text) ||
    mentionsStablePathOrRepository(text) ||
    mentionsProjectMilestone(text) ||
    mentionsStablePreferenceOrWorkflow(text) ||
    mentionsTroubleshootingOrConfig(text)
  );
}
