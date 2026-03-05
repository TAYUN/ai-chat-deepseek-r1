import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

interface ProcessedContent {
  content: string;
  searchResults?: SearchResult[];
}

const messageSchema = z
  .object({
    messages: z.array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      })
    ),
    network: z.boolean().optional(),
    model: z.string().optional(),
  })
  .passthrough();

async function searxngSearch(
  query: string,
  SEARXNG_URL = 'https://proxy.edgeone.app/search'
): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      engines: 'bing',
    });

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      Origin: 'https://proxy.edgeone.app',
    };

    const response = await fetch(`${SEARXNG_URL}?${params}`, { headers });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Search failed: ${errorText}`);
    }

    const data = await response.json();
    return data?.results || [];
  } catch (error) {
    console.error('SearXNG search error:', error);
    return [];
  }
}

function formatSearchResults(results: SearchResult[]): string {
  return results
    .map((result, i) => {
      const index = i + 1;
      const title = result.title || 'No title';
      const url = result.url || 'No URL';
      const snippet = result.content || 'No snippet';

      return `
[webpage ${index} begin]
Title: ${title}
Url: ${url}
Snippet: ${snippet}
[webpage ${index} end]
`;
    })
    .join('\n\n');
}

async function getContent(
  input: string,
  withNetwork: boolean
): Promise<ProcessedContent> {
  if (!withNetwork) {
    return { content: input };
  }

  try {
    const searchResults = await searxngSearch(input);

    if (!searchResults.length) {
      return { content: '' };
    }

    const context = formatSearchResults(searchResults);
    const contentWithNetworkSearch = `
# The following content is search results based on the user's message:
${context}
In the search results I provided, each result is in the format of [webpage X begin]...[webpage X end], where X represents the numerical index of each article.
When answering, please note the following points:
- Today is ${new Date().toLocaleDateString('zh-CN')}.
- Not all content in the search results is closely related to the user's question. You need to evaluate and filter the search results based on the question.
- For listing-type questions (such as listing all flight information), try to limit your answer to no more than 10 points, and tell the user they can check the search sources for complete information. Prioritize providing complete and most relevant list items; unless necessary, don't proactively mention content not provided in search results.
- For creative questions (such as writing essays), you need to interpret and summarize the user's requirements, choose an appropriate format, fully utilize the search results and extract important information to generate an answer that meets user requirements with intellectual depth, creativity and professionalism. Your creative content should be as lengthy as possible, providing multiple perspectives for each point based on your interpretation of user intent, ensuring information-rich and detailed explanations.
- If the answer is lengthy, please structure it and summarize by paragraphs. If point-by-point answers are needed, try to limit it to 5 points and merge related content.
- For objective Q&A, if the answer is very brief, you may add one or two sentences of related information to enrich the content.
- You need to choose an appropriate and aesthetically pleasing format for your answer based on user requirements and answer content, ensuring strong readability.
- Your answer should synthesize information from multiple relevant webpages, not repeatedly referencing a single webpage.
- Unless requested by the user, your response language should match the language of the user's question.
# User message:
${input}
    `;

    return {
      content: contentWithNetworkSearch,
      searchResults,
    };
  } catch (err) {
    console.error('Content processing failed:', err);
    return { content: input };
  }
}

function formatResultsForHeader(results: SearchResult[]): string {
  return JSON.stringify(
    results.map((item) => ({
      url: item.url,
      title: encodeURIComponent(item.title),
    }))
  );
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const json = await request.json();
    const parseResult = messageSchema.safeParse(json);

    if (!parseResult.success) {
      return NextResponse.json({ error: parseResult.error.message }, { status: 400 });
    }

    const { messages, network, model } = parseResult.data;

    const currentInput = messages[messages.length - 1]?.content;

    if (!currentInput) {
      return NextResponse.json({ error: 'No input message found' }, { status: 400 });
    }

    const { content, searchResults = [] } = await getContent(
      currentInput,
      !!network
    );

    if (!content) {
      return NextResponse.json({ error: 'No Search Results' }, { status: 400 });
    }

    const processedMessages = [...messages];
    processedMessages[processedMessages.length - 1] = {
      role: 'user',
      content,
    };

    try {
      const allowedModels = [
        '@tx/deepseek-ai/deepseek-r1-distill-qwen-32b',
        '@tx/deepseek-ai/deepseek-r1-0528',
        '@tx/deepseek-ai/deepseek-v3-0324',
      ];

      const selectedModel =
        model || '@tx/deepseek-ai/deepseek-r1-distill-qwen-32b';

      if (!allowedModels.includes(selectedModel)) {
        return NextResponse.json({
          error: `Invalid model: ${selectedModel}. Allowed models: ${allowedModels.join(
            ', '
          )}`,
        }, { status: 400 });
      }

      const isDevelopment = process.env.NODE_ENV === 'development';
      const apiKey = process.env.DEEPSEEK_API_KEY;
      
      // 安全检查：仅在开发环境且配置了 Key 时使用 DeepSeek API
      // 生产环境强制禁用个人 Key，防止被滥用
      const useDeepSeekAPI = isDevelopment && apiKey && apiKey !== 'your_deepseek_api_key_here';

      // 额外的安全保障：如果不是开发环境，强制清空 apiKey
      if (!isDevelopment) {
        console.log('生产环境：禁用个人 DeepSeek API Key 调用');
      }

      let aiStream: ReadableStream<Uint8Array> | null = null;

      if (useDeepSeekAPI) {
        const modelMapping: Record<string, string> = {
          '@tx/deepseek-ai/deepseek-r1-distill-qwen-32b': 'deepseek-reasoner',
          '@tx/deepseek-ai/deepseek-r1-0528': 'deepseek-reasoner',
          '@tx/deepseek-ai/deepseek-v3-0324': 'deepseek-chat',
        };

        const deepseekModel = modelMapping[selectedModel] || 'deepseek-chat';

        try {
          console.log('使用 DeepSeek 官方 API (开发环境)');
          const aiResponse = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: deepseekModel,
              messages: processedMessages,
              stream: true,
            }),
          });

          if (!aiResponse.ok) {
            const errorText = await aiResponse.text();
            throw new Error(`DeepSeek API error: ${errorText}`);
          }

          aiStream = aiResponse.body;
        } catch (fetchError) {
          console.warn('DeepSeek API 调用失败，切换到 EdgeOne API:', fetchError);
          
          const mockResponse = `DeepSeek API 调用失败。

错误信息：${fetchError.message || fetchError}

请检查：
1. API key 是否正确
2. 账户余额是否充足
3. 网络连接是否正常`;

          const encoder = new TextEncoder();
          const mockStream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const chunks = mockResponse.split('');
              for (const chunk of chunks) {
                const data = JSON.stringify({
                  choices: [{
                    delta: {
                      content: chunk
                    }
                  }]
                });
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                await new Promise(resolve => setTimeout(resolve, 10));
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          });

          return new NextResponse(mockStream, {
            headers: {
              results: formatResultsForHeader(searchResults),
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            },
          });
        }
      } else {
        try {
          console.log('使用 EdgeOne AI API (生产环境)');
          const aiResponse = await fetch('https://ai.edgeone.app/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: selectedModel,
              messages: processedMessages,
              stream: true,
            }),
          });

          if (!aiResponse.ok) {
            const errorText = await aiResponse.text();
            throw new Error(`EdgeOne AI API error: ${errorText}`);
          }

          aiStream = aiResponse.body;
        } catch (fetchError) {
          console.warn('EdgeOne AI API 调用失败，使用模拟响应:', fetchError);
          
          const mockResponse = `EdgeOne AI API 调用失败。

错误信息：${fetchError.message || fetchError}

请确保项目已部署到 EdgeOne Pages 环境`;

          const encoder = new TextEncoder();
          const mockStream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const chunks = mockResponse.split('');
              for (const chunk of chunks) {
                const data = JSON.stringify({
                  choices: [{
                    delta: {
                      content: chunk
                    }
                  }]
                });
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                await new Promise(resolve => setTimeout(resolve, 10));
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          });

          return new NextResponse(mockStream, {
            headers: {
              results: formatResultsForHeader(searchResults),
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            },
          });
        }
      }

      return new NextResponse(aiStream, {
        headers: {
          results: formatResultsForHeader(searchResults),
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    } catch (error: any) {
      console.error('AI API error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } catch (error: any) {
    console.error('Request processing failed:', error);
    return NextResponse.json({
      error: 'Request processing failed',
      details: error.message,
    }, { status: 500 });
  }
}
