package repositories

import "database/sql"

type Repository struct {
	DB *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
	return &Repository{DB: db}
}

func (r *Repository) GetAccountsId() ([]int, error) {
	rows, err := r.DB.Query(`
		SELECT id
		FROM account
		WHERE user_id = 6
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var accounts []int
	for rows.Next() {
		var accountID int
		if err := rows.Scan(&accountID); err != nil {
			return nil, err
		}
		accounts = append(accounts, accountID)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return accounts, nil
}
