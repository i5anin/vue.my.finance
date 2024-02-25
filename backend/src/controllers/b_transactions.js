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
async function getIncomeAndExpensePerMonth(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT
  DATE_TRUNC('month', date) AS month,
  COALESCE(SUM(CASE WHEN operation_amount > 0 THEN operation_amount ELSE 0 END), 0) AS total_income,
  COALESCE(SUM(CASE WHEN operation_amount < 0 THEN operation_amount ELSE 0 END), 0) AS total_expense,
  COALESCE(SUM(CASE WHEN operation_amount > 0 THEN operation_amount ELSE 0 END), 0) +
  COALESCE(SUM(CASE WHEN operation_amount < 0 THEN operation_amount ELSE 0 END), 0) AS net_income
FROM
  (SELECT date_of_operation AS date, operation_amount FROM dbo.transactions WHERE status != 'FAILED'
   UNION ALL
   SELECT DATE_TRUNC('month', NOW() AT TIME ZONE 'Europe/Moscow'), 0) subquery
GROUP BY month
ORDER BY month DESC
`
    )

    res.json(rows)
  } catch (error) {
    console.error('Error while fetching income and expense per month:', error)
    res.status(500).send(error.message)
  }
}

// В controllers/b_transactions.js
// В файле controllers/b_transactions.js

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

async function getIncomeExpenseProfitForMonthAndYear(req, res) {
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

    // Обновленный запрос исключает транзакции со статусом "FAILED"
    const { rows } = await pool.query(
      `SELECT transaction_id, date_of_operation, date_of_payment, card_number, status,
              operation_amount::float AS operation_amount, operation_currency, payment_amount::float AS payment_amount, payment_currency,
              cashback, category, mcc, description, bonuses, rounding, total_amount_with_rounding
       FROM dbo.transactions
       WHERE date_of_operation >= $1 AND date_of_operation <= $2
         AND description <> 'Перевод между счетами'
         AND status <> 'FAILED'
       ORDER BY date_of_operation`,
      [firstDayOfMonth, lastDayOfMonth]
    )

    // Применяем фильтрацию для исключения пар транзакций с противоположными суммами в пределах 30 минут
    const filteredRows = rows.filter((row, index, array) => {
      return !array.some((otherRow) => {
        if (row.transaction_id !== otherRow.transaction_id) {
          const diffTime = Math.abs(
            new Date(row.date_of_operation) -
              new Date(otherRow.date_of_operation)
          )
          const diffMinutes = diffTime / (1000 * 60)
          return (
            diffMinutes <= 3000 &&
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

async function getAllTransactions(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT transaction_id, date_of_operation, date_of_payment, card_number, status,
              operation_amount, operation_currency, payment_amount, payment_currency,
              cashback, category, mcc, description, bonuses, rounding, total_amount_with_rounding
       FROM dbo.transactions
       ORDER BY date_of_operation DESC`
    )
    res.json(rows)
  } catch (error) {
    console.error('Error while fetching all transactions:', error)
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
    const daysInMonth = lastDayOfMonth.getDate()

    const { rows } = await pool.query(
      `SELECT EXTRACT(DAY FROM date_of_operation) as day, SUM(operation_amount) as total
       FROM dbo.transactions
       WHERE date_of_operation >= $1
         AND date_of_operation <= $2
         AND description <> 'Перевод между счетами'
       GROUP BY EXTRACT(DAY FROM date_of_operation)
       ORDER BY day`,
      [firstDayOfMonth, lastDayOfMonth]
    )

    // Создаем массив для всех дней месяца
    let chartData = []
    for (let day = 1; day <= daysInMonth; day++) {
      // Находим запись для текущего дня
      const dayData = rows.find((row) => row.day == day)
      // Если данных нет, используем 0
      chartData.push({
        name: day.toString(),
        pl: dayData ? dayData.total : '0.00', // Убедитесь, что формат соответствует ожидаемому
      })
    }

    res.json(chartData)
  } catch (error) {
    console.error('Error while fetching chart data:', error)
    res.status(500).send(error.message)
  }
}

// добавьте соответствующий маршрут

module.exports = {
  getIncomeAndExpensePerMonth,
  getTransactionsForMonthAndYear,
  getAvailableYearsAndMonths,
  getChartForMonthAndYear,
  getIncomeExpenseProfitForMonthAndYear,
  getAllTransactions,
  getMonthlyIncomeExpenseProfit,
}
