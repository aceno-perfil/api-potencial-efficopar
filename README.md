# Perdas GPT

Sistema de análise de potencial de receita de imóveis utilizando inteligência artificial (OpenAI) e banco de dados Supabase.

## 📋 Descrição

Este projeto é uma API Node.js que processa dados de imóveis e utiliza GPT para avaliar o potencial de receita, identificando oportunidades de melhoria e ações sugeridas.

## 🚀 Funcionalidades

- **Análise de Imóveis**: Processa dados históricos de imóveis por período e setor
- **IA para Avaliação**: Utiliza OpenAI Assistant para analisar potencial de receita
- **Integração Supabase**: Armazena e recupera dados de imóveis
- **Processamento em Lote**: Processa múltiplos imóveis de forma eficiente
- **API RESTful**: Endpoints para teste e processamento

## 🛠️ Tecnologias

- **Node.js** - Runtime JavaScript
- **Express** - Framework web
- **OpenAI** - API de inteligência artificial
- **Supabase** - Banco de dados e backend
- **dotenv** - Gerenciamento de variáveis de ambiente

## 📦 Instalação

1. Clone o repositório:
```bash
git clone <url-do-repositorio>
cd perdas-gpt
```

2. Instale as dependências:
```bash
npm install
```

3. Configure as variáveis de ambiente:
```bash
cp .env.example .env
```

4. Edite o arquivo `.env` com suas credenciais:
```env
OPENAI_API_KEY=sua_chave_openai
SUPABASE_URL=sua_url_supabase
SUPABASE_SERVICE_KEY=sua_chave_supabase
PORT=3000
```

## 🚀 Execução

```bash
npm start
```

O servidor estará rodando em `http://localhost:3000`

## 📚 Endpoints

### Health Check
- `GET /healthz` - Verifica se a API está funcionando

### Teste de Conexão
- `GET /testar-supabase/:ano/:mes/:setor` - Testa conexão com Supabase
- `GET /testar-gpt/:ano/:mes/:setor` - Testa integração com OpenAI

### Processamento
- `GET /rodar/:ano/:mes/:setor` - Processa imóveis de um setor específico
- `POST /webhook` - Webhook para processamento via requisições externas

## 📊 Estrutura de Dados

### Entrada
- **Período**: Ano e mês no formato YYYY-MM-01
- **Setor**: Identificador do setor geográfico

### Saída
- **Potencial Score**: Pontuação de 0-100
- **Nível de Potencial**: Classificação (baixo, médio, alto)
- **Ações Sugeridas**: Recomendações específicas
- **Justificativas**: Explicações detalhadas

## 🔧 Configuração

### Variáveis de Ambiente Obrigatórias

- `OPENAI_API_KEY`: Chave da API OpenAI
- `SUPABASE_URL`: URL do projeto Supabase
- `SUPABASE_SERVICE_KEY`: Chave de serviço do Supabase
- `PORT`: Porta do servidor (opcional, padrão: 3000)

### Assistant OpenAI

O projeto utiliza um Assistant OpenAI específico com ID: `asst_xtxEvFNTsyZyfnNNlcMiYU67`

## 📈 Monitoramento

O sistema inclui logs detalhados para acompanhar:
- Processamento de lotes
- Status de execução
- Erros e sucessos
- Tempo de processamento

## 🤝 Contribuição

1. Faça um fork do projeto
2. Crie uma branch para sua feature (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. Push para a branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

## 📄 Licença

Este projeto está sob a licença ISC.

## 📞 Suporte

Para dúvidas ou suporte, entre em contato através dos issues do GitHub.
