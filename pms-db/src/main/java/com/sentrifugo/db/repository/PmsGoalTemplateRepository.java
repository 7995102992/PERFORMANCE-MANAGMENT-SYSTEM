package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsGoalTemplateEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;

import java.util.Optional;
import java.util.UUID;

/** The screen 2.1 list filters go through {@code PmsGoalTemplateSpecifications}. */
public interface PmsGoalTemplateRepository extends JpaRepository<PmsGoalTemplateEntity, UUID>,
        JpaSpecificationExecutor<PmsGoalTemplateEntity> {

    /** Organisation-scoped lookup: the way to load a row without crossing tenants. */
    Optional<PmsGoalTemplateEntity> findByIdAndOrganisationId(UUID id, UUID organisationId);
}
