const { Pool } = require('pg')
const { getNetworkDetails } = require('../db_type')
const config = require('../config')

const networkDetails = getNetworkDetails()
const dbConfig =
  networkDetails.databaseType === 'build'
    ? config.dbConfig
    : config.dbConfigTest

// Создание пула соединений с базой данных
const pool = new Pool(dbConfig)

async function getMonthlyIncomeExpenseProfit(req, res) {
  try {
    const query = `
      SELECT
        EXTRACT(YEAR FROM date_of_operation) AS year,
        EXTRACT(MONTH FROM date_of_operation) AS month,
        COALESCE(SUM(CASE WHEN operation_amount > 0 THEN operation_amount ELSE 0 END), 0) AS total_income,
        COALESCE(SUM(CASE WHEN operation_amount < 0 THEN ABS(operation_amount) ELSE 0 END), 0) AS total_expense,
        COALESCE(SUM(operation_amount), 0) AS net_profit
      FROM
        dbo.transactions
      WHERE
        description <> 'Перевод между счетами' AND
        description <> 'Закрытие вклада Тинькофф Банк' AND
        status <> 'FAILED'
      GROUP BY
        EXTRACT(YEAR FROM date_of_operation),
        EXTRACT(MONTH FROM date_of_operation)
      ORDER BY
        year DESC,
        month DESC
    `

    const { rows } = await pool.query(query)

    const formattedResults = rows.map((row) => ({
      year: row.year,
      month: row.month,
      total_income: parseFloat(row.total_income).toFixed(2),
      total_expense: parseFloat(row.total_expense).toFixed(2),
      net_profit: parseFloat(row.net_profit).toFixed(2),
    }))

    // Фильтрация результатов, чтобы начать с февраля 2024 и идти в обратном порядке
    const sortedAndFilteredResults = formattedResults.sort((a, b) => {
      const dateA = new Date(a.year, a.month - 1)
      const dateB = new Date(b.year, b.month - 1)
      return dateB - dateA // Сортировка по убыванию
    })

    res.json(sortedAndFilteredResults)
  } catch (error) {
    console.error(
      'Error while fetching monthly income, expense, and profit descending:',
      error
    )
    res.status(500).send(error.message)
  }
}

async function getIncomeExpenseProfit(req, res) {
  const { year, month } = req.params

  try {
    const query = `
      SELECT
        COALESCE(SUM(CASE WHEN operation_amount > 0 THEN operation_amount ELSE 0 END), 0) AS total_income,
        COALESCE(SUM(CASE WHEN operation_amount < 0 THEN ABS(operation_amount) ELSE 0 END), 0) AS total_expense,
        (COALESCE(SUM(operation_amount), 0)) AS net_profit
      FROM
        dbo.transactions
      WHERE
        EXTRACT(YEAR FROM date_of_operation) = $1 AND
        EXTRACT(MONTH FROM date_of_operation) = $2 AND
        description <> 'Перевод между счетами' AND
        status <> 'FAILED'
    `

    const { rows } = await pool.query(query, [year, month])

    if (rows.length > 0) {
      const row = rows[0]
      res.json({
        year,
        month,
        total_income: parseFloat(row.total_income).toFixed(2),
        total_expense: parseFloat(row.total_expense).toFixed(2),
        net_profit: parseFloat(row.net_profit).toFixed(2),
      })
    } else {
      res.json({
        year,
        month,
        total_income: '0.00',
        total_expense: '0.00',
        net_profit: '0.00',
      })
    }
  } catch (error) {
    console.error('Error while fetching income, expense, and profit:', error)
    res.status(500).send(error.message)
  }
}

// Функция для получения транзакций за текущий месяц
async function getTransactionsForMonthAndYear(req, res) {
  try {
    const year = req.params.year
    const month = req.params.month

    const firstDayOfMonth = new Date(year, month - 1, 1)
    const lastDayOfMonth = new Date(year, month, 0)

    const { rows } = await pool.query(
      `SELECT transaction_id, date_of_operation, date_of_payment, card_number, status,
              operation_amount::float AS operation_amount, operation_currency, payment_amount::float AS payment_amount, payment_currency,
              cashback, category, mcc, description, bonuses, rounding, total_amount_with_rounding,
              CASE WHEN my_comment IS NOT NULL THEN my_comment ELSE '' END AS my_comment
       FROM dbo.transactions
       WHERE date_of_operation >= $1 AND date_of_operation <= $2
         AND date_part('year', date_of_operation) = $3
         AND date_part('month', date_of_operation) = $4
         AND description <> 'Перевод между счетами'
         AND description <> 'Закрытие вклада Тинькофф Банк'
         AND status <> 'FAILED'
       ORDER BY date_of_operation DESC`, // Изменено на DESC для сортировки от новых к старым
      [firstDayOfMonth, lastDayOfMonth, year, month]
    )

    const filteredRows = rows.filter((row, index, array) => {
      return !array.some((otherRow) => {
        if (row.transaction_id !== otherRow.transaction_id) {
          const diffTime = Math.abs(
            new Date(row.date_of_operation) -
              new Date(otherRow.date_of_operation)
          )
          const diffMinutes = diffTime / (1000 * 60)
          return (
            diffMinutes <= 30 &&
            row.operation_amount === -otherRow.operation_amount
          )
        }
        return false
      })
    })

    res.json(filteredRows)
  } catch (error) {
    console.error('Error while fetching transactions:', error)
    res.status(500).send(error.message)
  }
}

async function getAvailableYearsAndMonths(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT EXTRACT(YEAR FROM date_of_operation) AS year, EXTRACT(MONTH FROM date_of_operation) AS month
       FROM dbo.transactions
       GROUP BY year, month
       ORDER BY year DESC, month DESC`
    )

    const result = rows.reduce((acc, { year, month }) => {
      if (!acc[year]) {
        acc[year] = []
      }
      acc[year].push(month)
      return acc
    }, {})

    res.json(result)
  } catch (error) {
    console.error('Error while fetching available years and months:', error)
    res.status(500).send(error.message)
  }
}
// main
async function getChartForMonthAndYear(req, res) {
  try {
    const year = req.params.year
    const month = req.params.month

    const firstDayOfMonth = new Date(year, month - 1, 1)
    const lastDayOfMonth = new Date(year, month, 0)

    const { rows } = await pool.query(
      `
      SELECT COALESCE(my_category, category) AS effective_category, operation_amount, description
      FROM dbo.transactions
      WHERE date_of_operation >= $1
        AND date_of_operation <= $2
        AND operation_amount < 0
        AND description <> 'Перевод между счетами'
        AND description <> 'Закрытие вклада Тинькофф Банк'
        AND description <> 'Перевод по запросу самому себе'
        AND description <> 'Пополнение вклада'
    `,
      [firstDayOfMonth, lastDayOfMonth]
    )

    const categories = rows.reduce(
      (acc, { effective_category, operation_amount, description }) => {
        if (!acc[effective_category]) {
          acc[effective_category] = { total: 0, transactions: [] }
        }
        acc[effective_category].total += Math.abs(operation_amount)
        acc[effective_category].transactions.push({
          category: effective_category,
          amount: Math.abs(operation_amount).toFixed(2),
          description,
        })
        return acc
      },
      {}
    )

    // Вычисление общей суммы расходов
    const totalExpenses = Object.values(categories).reduce(
      (sum, { total }) => sum + total,
      0
    )

    // Добавление процентов к итоговым данным
    const chartData = Object.entries(categories)
      .map(([name, data]) => ({
        name,
        pl: data.total.toFixed(2),
        // Добавление процентной доли от общей суммы расходов
        percentage: ((data.total / totalExpenses) * 100).toFixed(2) + '%',
      }))
      .sort((a, b) => b.pl - a.pl) // Сортировка по убыванию итоговой суммы

    res.json(chartData)
  } catch (error) {
    console.error('Error while fetching chart data:', error)
    res.status(500).send(error.message)
  }
}

async function getTransactionById(req, res) {
  const { id } = req.params // Получение id из параметров запроса

  try {
    const { rows } = await pool.query(
      `SELECT * FROM dbo.transactions WHERE transaction_id = $1`,
      [id]
    )

    if (rows.length > 0) {
      res.json(rows[0]) // Возвращаем найденную транзакцию
    } else {
      res.status(404).send('Transaction not found') // Если транзакция не найдена, отправляем 404
    }
  } catch (error) {
    console.error('Error while fetching transaction by id:', error)
    res.status(500).send(error.message) // В случае ошибки возвращаем статус 500
  }
}

// добавьте соответствующий маршрут

module.exports = {
  getTransactionById,
  getTransactionsForMonthAndYear,
  getAvailableYearsAndMonths,
  getChartForMonthAndYear,
  getIncomeExpenseProfit,
  getMonthlyIncomeExpenseProfit,
}
