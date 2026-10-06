package com.sentrifugo.db.entity;

import jakarta.persistence.Column;
import jakarta.persistence.EntityListeners;
import jakarta.persistence.MappedSuperclass;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Id;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import org.springframework.data.annotation.CreatedBy;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.LastModifiedBy;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

import java.io.Serializable;
import java.time.LocalDateTime;
import java.util.UUID;

@Data
@MappedSuperclass
@AllArgsConstructor
@NoArgsConstructor
@SuperBuilder
@EntityListeners(AuditingEntityListener.class)
public abstract class BaseEntity<ID extends Serializable> {

    // No @GeneratedValue: Hibernate builds a generator from the erased bound of the generic ID (Serializable) and
    // fails for UUID ("Unknown integral data type for ids" / "Unanticipated return type [Serializable]").
    // The id is therefore assigned in generateId() just before persist.
    @Id
    @Column(name = "id", updatable = false, nullable = false)
    private ID id;

    @CreatedBy
    @Column(name = "created_by")
    private String createdBy;

    @LastModifiedBy
    @Column(name = "modified_by")
    private String modifiedBy;

    @CreatedDate
    @Column(name = "created_date", updatable = false)
    private LocalDateTime createdDate;

    @LastModifiedDate
    @Column(name = "modified_date")
    private LocalDateTime modifiedDate;

    @Column(
            name = "is_active",
            nullable = false,
            columnDefinition = "boolean default true"
    )
    @Builder.Default
    private Boolean isActive = true;

    @PrePersist
    void assignIdIfAbsent() {
        if (id == null) {
            id = generateId();
        }
    }

    /**
     * New primary key for this entity. Defaults to a random UUID, matching {@code BaseEntity<UUID>}; an entity
     * with a different ID type must override this.
     */
    @SuppressWarnings("unchecked")
    protected ID generateId() {
        return (ID) UUID.randomUUID();
    }
}