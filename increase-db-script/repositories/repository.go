package repositories

import (
	"database/sql"
	"fmt"

	"github.com/gabriel-hawerroth/increase-db-script/models"
	"github.com/lib/pq"
)

type Repository struct {
	DB *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
	return &Repository{DB: db}
}

func (r *Repository) GetAccountsId(userID int) ([]int, error) {
	rows, err := r.DB.Query(`
		SELECT id
		FROM account
		WHERE user_id = $1
	`, userID)
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

func (r *Repository) GetCategoriesId(userID int) ([]int, error) {
	rows, err := r.DB.Query(`
		SELECT id
		FROM category
		WHERE user_id = $1
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var categories []int
	for rows.Next() {
		var categoryID int
		if err := rows.Scan(&categoryID); err != nil {
			return nil, err
		}
		categories = append(categories, categoryID)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return categories, nil
}

func (r *Repository) DeleteReleasesByUserID(userID int) error {
	_, err := r.DB.Exec(`DELETE FROM release WHERE user_id = $1`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete releases for user_id %d: %w", userID, err)
	}
	return nil
}

func (r *Repository) BatchInsertReleases(releases []models.Release) error {
	txn, err := r.DB.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}

	stmt, err := txn.Prepare(pq.CopyIn(
		"release", // table name
		// columns
		"user_id", "description", "account_id", "amount", "type", "done",
		"category_id", "date", "time", "observation", "s3_file_name",
		"attachment_name", "duplicated_release_id", "repeat", "fixed_by",
		"credit_card_id", "is_balance_adjustment",
	))
	if err != nil {
		return fmt.Errorf("failed to prepare copy in statement: %w", err)
	}

	for _, release := range releases {
		// Convert big.Float to a float64 for pq driver, or handle as string if precision is critical
		amountFloat, _ := release.Amount.Float64()

		_, err = stmt.Exec(
			release.UserID,
			release.Description,
			release.AccountID,
			amountFloat, // Use converted float64
			release.Type,
			release.Done,
			release.CategoryID,
			release.Date,
			release.Time,
			release.Observation,
			release.S3FileName,
			release.AttachmentName,
			release.DuplicatedReleaseID,
			release.Repeat,
			release.FixedBy,
			release.CreditCardID,
			release.IsBalanceAdjustment,
		)
		if err != nil {
			// Attempt to rollback, but return the exec error primarily
			txn.Rollback()
			return fmt.Errorf("failed to exec statement for release %+v: %w", release, err)
		}
	}

	_, err = stmt.Exec() // Finalize the COPY operation
	if err != nil {
		txn.Rollback()
		return fmt.Errorf("failed to finalize copy in: %w", err)
	}

	err = stmt.Close()
	if err != nil {
		txn.Rollback()
		return fmt.Errorf("failed to close statement: %w", err)
	}

	return txn.Commit()
}
