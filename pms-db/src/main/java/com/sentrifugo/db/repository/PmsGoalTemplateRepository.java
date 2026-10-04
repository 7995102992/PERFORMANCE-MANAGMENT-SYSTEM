package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsGoalTemplateEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;
import java.util.UUID;

public interface PmsGoalTemplateRepository extends JpaRepository<PmsGoalTemplateEntity, UUID> {

    /** Organisation-scoped lookup: the way to load a row without crossing tenants. */
    Optional<PmsGoalTemplateEntity> findByIdAndOrganisationId(UUID id, UUID organisationId);
}
